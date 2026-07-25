import net from 'net';
import crypto from 'crypto';
import { getLogger } from '../utils/logger';
import { verifyCredentials } from '../core/users';
import { allocateForUser, pickSubnetId } from '../core/ip-allocator';
import {
  createSession,
  setTargetSocket,
  closeSession,
  getConnectionCount,
} from '../core/sessions';
import { recordBytes } from '../core/traffic';
import { getRateLimitRules, TokenBucket, getOrCreateTokenBucket } from '../core/rate-limiter';
import { getDb } from '../database/connection';

const SOCKS_VERSION = 0x05;
const AUTH_USER_PASS = 0x02;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;
const REP_SUCCESS = 0x00;
const REP_GENERAL_FAILURE = 0x01;
const REP_CONNECTION_NOT_ALLOWED = 0x02;
const REP_HOST_UNREACHABLE = 0x04;
const REP_CONNECTION_REFUSED = 0x05;
const REP_TTL_EXPIRED = 0x06;
const REP_COMMAND_NOT_SUPPORTED = 0x07;
const REP_ADDRESS_TYPE_NOT_SUPPORTED = 0x08;

export function createSocks5Server(port: number): net.Server {
  const log = getLogger();

  const server = net.createServer((clientSocket) => {
    let sessionId: string | null = null;
    let bucket: TokenBucket | null = null;

    clientSocket.on('error', (err) => {
      log.debug({ err: err.message }, 'Client socket error');
    });

    // Release allocated IPv6 if client drops before/after relay cleanup
    clientSocket.on('close', () => {
      if (sessionId) closeSession(sessionId);
    });

    // Phase 1: Method negotiation
    clientSocket.once('data', (data) => {
      if (data.length < 3 || data[0] !== SOCKS_VERSION) {
        clientSocket.destroy();
        return;
      }

      clientSocket.write(Buffer.from([SOCKS_VERSION, AUTH_USER_PASS]));

      // Phase 2: Authentication (RFC 1929)
      clientSocket.once('data', (authData) => {
        if (authData.length < 4 || authData[0] !== 0x01) {
          clientSocket.write(Buffer.from([0x01, 0x01]));
          clientSocket.destroy();
          return;
        }

        const ulen = authData[1];
        const username = authData.slice(2, 2 + ulen).toString();
        const plen = authData[2 + ulen];
        const password = authData.slice(3 + ulen, 3 + ulen + plen).toString();

        const user = verifyCredentials(username, password);
        if (!user) {
          log.warn({ username }, 'SOCKS5 authentication failed');
          clientSocket.write(Buffer.from([0x01, 0x01]));
          clientSocket.destroy();
          return;
        }

        const userId = user.id;

        // Rate limit check
        const limits = getRateLimitRules(userId);
        if (limits.max_connections !== null) {
          if (getConnectionCount(userId) >= limits.max_connections) {
            log.warn({ userId }, 'Connection limit exceeded');
            clientSocket.write(Buffer.from([0x01, 0x01]));
            clientSocket.destroy();
            return;
          }
        }

        if (limits.max_bandwidth !== null) {
          bucket = getOrCreateTokenBucket(userId, limits.max_bandwidth);
        }

        clientSocket.write(Buffer.from([0x01, 0x00])); // auth success

        // Phase 3: Request
        clientSocket.once('data', (reqData) => {
          handleRequest(reqData, clientSocket, userId, user.mode, bucket);
        });
      });
    });

    function handleRequest(
      data: Buffer,
      clientSocket: net.Socket,
      userId: string,
      mode: 'sticky' | 'random',
      bucket: TokenBucket | null
    ): void {
      if (data.length < 5 || data[0] !== SOCKS_VERSION) {
        sendReply(clientSocket, REP_GENERAL_FAILURE);
        return;
      }

      const cmd = data[1];
      const atyp = data[3];

      if (cmd !== CMD_CONNECT) {
        sendReply(clientSocket, REP_COMMAND_NOT_SUPPORTED);
        return;
      }

      let targetHost: string;
      let targetPort: number;

      if (atyp === ATYP_IPV4) {
        if (data.length < 10) {
          sendReply(clientSocket, REP_GENERAL_FAILURE);
          return;
        }
        targetHost = `${data[4]}.${data[5]}.${data[6]}.${data[7]}`;
        targetPort = data.readUInt16BE(8);
      } else if (atyp === ATYP_DOMAIN) {
        const domainLen = data[4];
        if (data.length < 7 + domainLen) {
          sendReply(clientSocket, REP_GENERAL_FAILURE);
          return;
        }
        targetHost = data.slice(5, 5 + domainLen).toString();
        targetPort = data.readUInt16BE(5 + domainLen);
      } else if (atyp === ATYP_IPV6) {
        const parts: string[] = [];
        for (let i = 0; i < 8; i++) {
          parts.push(data.readUInt16BE(4 + i * 2).toString(16));
        }
        targetHost = parts.join(':');
        targetPort = data.readUInt16BE(20);
      } else {
        sendReply(clientSocket, REP_ADDRESS_TYPE_NOT_SUPPORTED);
        return;
      }

      log.debug({ userId, targetHost, targetPort, mode }, 'SOCKS5 CONNECT');

      // Get user's subnet bindings
      const db = getDb();
      const bindings = db.prepare(
        `SELECT usb.subnet_id FROM user_subnet_bindings usb
         JOIN subnets s ON usb.subnet_id = s.id
         WHERE usb.user_id = ? AND s.status = 'active'`
      ).all(userId) as { subnet_id: string }[];

      if (bindings.length === 0) {
        log.warn({ userId }, 'No active subnet bindings for user');
        sendReply(clientSocket, REP_GENERAL_FAILURE);
        return;
      }

      const subnetId = pickSubnetId(
        userId,
        bindings.map((b) => b.subnet_id),
        mode
      );

      let ipv6Addr: string;
      try {
        ipv6Addr = allocateForUser(userId, subnetId, mode);
      } catch (err: any) {
        log.error({ err: err.message, userId }, 'Failed to allocate IPv6');
        sendReply(clientSocket, REP_GENERAL_FAILURE);
        return;
      }

      const session = createSession(userId, ipv6Addr, clientSocket);
      sessionId = session.id;

      const targetSocket = net.createConnection({
        host: targetHost,
        port: targetPort,
        localAddress: ipv6Addr,
        family: 6,
      });

      // Hard timeout: if the connect or first data doesn't happen within
      // 30 seconds, give up (prevents hanging when target is unreachable).
      targetSocket.setTimeout(30000, () => {
        if (!targetSocket.destroyed) {
          targetSocket.destroy(new Error('Connection timed out after 30s'));
        }
      });

      setTargetSocket(session.id, targetSocket);

      targetSocket.on('connect', () => {
        const reply = buildReply(REP_SUCCESS, targetSocket);
        clientSocket.write(reply);
        relayData(clientSocket, targetSocket, userId, bucket, session.id);
      });

      targetSocket.on('error', (err) => {
        log.warn({ err: err.message, targetHost }, 'Failed to connect to target');
        const replyCode = mapErrorToReplyCode(err);
        sendReply(clientSocket, replyCode);
        // Gracefully close: end() flushes the reply then sends FIN,
        // unlike destroy() which drops pending writes.
        if (!clientSocket.destroyed) {
          clientSocket.end();
        }
        closeSession(session.id);
      });
    }
  });

  server.on('error', (err) => {
    log.error({ err: err.message }, 'SOCKS5 server error');
  });

  return server;
}

function sendReply(socket: net.Socket, replyCode: number): void {
  if (socket.destroyed) return;
  const reply = Buffer.alloc(10);
  reply[0] = SOCKS_VERSION; reply[1] = replyCode; reply[2] = 0; reply[3] = ATYP_IPV4;
  reply.writeUInt16BE(0, 8);
  socket.write(reply);
}

function buildReply(replyCode: number, targetSocket: net.Socket): Buffer {
  const addr = targetSocket.localAddress;
  const port = targetSocket.localPort || 0;

  if (!addr || !addr.includes(':')) {
    const buf = Buffer.alloc(10);
    buf[0] = SOCKS_VERSION; buf[1] = replyCode; buf[2] = 0; buf[3] = ATYP_IPV4;
    const octets = (addr || '0.0.0.0').split('.').map(Number);
    buf[4] = octets[0] || 0; buf[5] = octets[1] || 0; buf[6] = octets[2] || 0; buf[7] = octets[3] || 0;
    buf.writeUInt16BE(port, 8);
    return buf;
  }

  const buf = Buffer.alloc(22);
  buf[0] = SOCKS_VERSION; buf[1] = replyCode; buf[2] = 0; buf[3] = ATYP_IPV6;
  const hextets = addr.split(':');
  for (let i = 0; i < 8; i++) {
    buf.writeUInt16BE(parseInt(hextets[i] || '0', 16), 4 + i * 2);
  }
  buf.writeUInt16BE(port, 20);
  return buf;
}

function mapErrorToReplyCode(err: NodeJS.ErrnoException): number {
  switch (err.code) {
    case 'ENETUNREACH': case 'EHOSTUNREACH': return REP_HOST_UNREACHABLE;
    case 'ECONNREFUSED': return REP_CONNECTION_REFUSED;
    case 'ETIMEDOUT': return REP_TTL_EXPIRED;
    case 'EACCES': case 'EPERM': return REP_CONNECTION_NOT_ALLOWED;
    default: return REP_GENERAL_FAILURE;
  }
}

function relayData(
  client: net.Socket,
  target: net.Socket,
  userId: string,
  bucket: TokenBucket | null,
  sessionId: string
): void {
  let clientBytes = 0;
  let targetBytes = 0;
  let closed = false;

  function doClose(): void {
    if (closed) return;
    closed = true;
    if (clientBytes > 0 || targetBytes > 0) {
      recordBytes(userId, targetBytes, clientBytes);
    }
    closeSession(sessionId);
  }

  client.on('data', (data) => {
    if (bucket && !bucket.consume(data.length)) {
      client.pause();
      setTimeout(() => client.resume(), 100);
      return;
    }
    clientBytes += data.length;
    if (!target.destroyed) target.write(data);
  });

  target.on('data', (data) => {
    targetBytes += data.length;
    if (!client.destroyed) client.write(data);
  });

  client.on('close', () => { if (!target.destroyed) target.destroy(); doClose(); });
  target.on('close', () => { if (!client.destroyed) client.destroy(); doClose(); });
  client.on('error', () => { if (!target.destroyed) target.destroy(); doClose(); });
  target.on('error', () => { if (!client.destroyed) client.destroy(); doClose(); });
}
