import net from 'net';
import { getLogger } from '../utils/logger';
import { authenticateProxyUser } from '../core/users';
import { allocateForUser, pickSubnetId } from '../core/ip-allocator';
import {
  createSession,
  setTargetSocket,
  closeSession,
  getConnectionCount,
} from '../core/sessions';
import { recordBytes } from '../core/traffic';
import { getRateLimitRules, TokenBucket, getOrCreateTokenBucket } from '../core/rate-limiter';
import { resolveTargetRoute, invalidateRoute, TargetRoute } from '../core/target-resolver';
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

/**
 * Bound the method/auth/request exchange. This timer is cleared as soon as the
 * request arrives, so relayed connections may sit idle without being cut.
 */
const HANDSHAKE_TIMEOUT_MS = 30_000;

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

    // A client that connects and never sends a method selection would hold
    // this socket forever, and later a session slot too.
    clientSocket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => {
      log.debug('SOCKS5 handshake timed out');
      clientSocket.destroy();
    });

    // Phase 1: Method negotiation
    clientSocket.once('data', (data) => {
      if (data.length < 3 || data[0] !== SOCKS_VERSION) {
        clientSocket.destroy();
        return;
      }

      clientSocket.write(Buffer.from([SOCKS_VERSION, AUTH_USER_PASS]));

      // Phase 2: Authentication (RFC 1929)
      clientSocket.once('data', async (authData) => {
        try {
          if (authData.length < 4 || authData[0] !== 0x01) {
            clientSocket.write(Buffer.from([0x01, 0x01]));
            clientSocket.destroy();
            return;
          }

          const ulen = authData[1];
          const username = authData.slice(2, 2 + ulen).toString();
          const plen = authData[2 + ulen];
          const password = authData.slice(3 + ulen, 3 + ulen + plen).toString();

          const identity = await authenticateProxyUser(username, password);
          // bcrypt ran off the event loop; the client may be gone by now.
          if (clientSocket.destroyed) return;
          if (!identity) {
            log.warn({ username }, 'SOCKS5 authentication failed');
            clientSocket.write(Buffer.from([0x01, 0x01]));
            clientSocket.destroy();
            return;
          }

          const userId = identity.user.id;

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
            // The handshake is complete; long-lived relays must not inherit
            // the handshake deadline.
            clientSocket.setTimeout(0);
            // Request handling is async (target resolution); an escaping
            // rejection would otherwise take down the process.
            handleRequest(
              reqData,
              clientSocket,
              userId,
              identity.mode,
              identity.stickyKey,
              bucket
            ).catch((err) => {
              log.error({ err: err.message, userId }, 'Unhandled error while handling SOCKS5 request');
              if (!clientSocket.destroyed) {
                clientSocket.destroy();
              }
            });
          });
        } catch (err) {
          log.error({ err }, 'Error while authenticating SOCKS5 client');
          if (!clientSocket.destroyed) {
            clientSocket.destroy();
          }
        }
      });
    });

    async function handleRequest(
      data: Buffer,
      clientSocket: net.Socket,
      userId: string,
      mode: 'sticky' | 'random',
      stickyKey: string | null,
      bucket: TokenBucket | null
    ): Promise<void> {
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

      log.debug({ userId, targetHost, targetPort, mode, stickyKey }, 'SOCKS5 CONNECT');

      // Resolve to a concrete IPv6 address first. Names without an AAAA
      // record are often still reachable over IPv6 through their CDN, and
      // names with no path at all should not churn an address allocation
      // they will never use.
      let route: TargetRoute;
      try {
        route = await resolveTargetRoute(targetHost, targetPort);
      } catch (err: any) {
        log.warn({ err: err.message, targetHost, targetPort }, 'No IPv6 route to target');
        sendReply(clientSocket, REP_HOST_UNREACHABLE);
        if (!clientSocket.destroyed) {
          clientSocket.end();
        }
        return;
      }

      // The client may have given up while we were resolving.
      if (clientSocket.destroyed) return;

      if (route.addresses.length === 0) {
        log.warn({ targetHost }, 'Resolver returned no addresses');
        sendReply(clientSocket, REP_HOST_UNREACHABLE);
        if (!clientSocket.destroyed) {
          clientSocket.end();
        }
        return;
      }

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
        mode,
        stickyKey
      );

      let ipv6Addr: string;
      try {
        ipv6Addr = allocateForUser(userId, subnetId, mode, stickyKey);
      } catch (err: any) {
        log.error({ err: err.message, userId }, 'Failed to allocate IPv6');
        sendReply(clientSocket, REP_GENERAL_FAILURE);
        return;
      }

      const session = createSession(userId, ipv6Addr, clientSocket);
      sessionId = session.id;

      const candidates = route.addresses;
      let attempt = 0;
      let established = false;

      const connectToCandidate = (): void => {
        const address = candidates[attempt++];

        const targetSocket = net.createConnection({
          host: address,
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
          established = true;
          log.debug(
            { targetHost, address, kind: route.kind, provider: route.provider },
            'Target connected'
          );
          const reply = buildReply(REP_SUCCESS, targetSocket);
          clientSocket.write(reply);
          relayData(clientSocket, targetSocket, userId, bucket, session.id);
        });

        targetSocket.on('error', (err) => {
          // Once relaying starts the socket carries payload, not protocol —
          // writing a SOCKS reply into it would corrupt the stream. relayData
          // owns teardown from here.
          if (established) {
            log.debug(
              { err: err.message, targetHost, address },
              'Target connection error during relay'
            );
            return;
          }

          // A stale AAAA or a dead anycast edge can fail even though the name
          // resolved; try the next candidate before giving up on the client.
          if (attempt < candidates.length && !clientSocket.destroyed) {
            log.debug(
              { err: err.message, targetHost, address },
              'Target address unreachable, trying next candidate'
            );
            connectToCandidate();
            return;
          }

          log.warn({ err: err.message, targetHost, address }, 'Failed to connect to target');
          // Every candidate for this route is dead — re-resolve next time
          // rather than serving the same broken address until the TTL runs out.
          invalidateRoute(targetHost, targetPort);

          const replyCode = mapErrorToReplyCode(err);
          sendReply(clientSocket, replyCode);
          // Gracefully close: end() flushes the reply then sends FIN,
          // unlike destroy() which drops pending writes.
          if (!clientSocket.destroyed) {
            clientSocket.end();
          }
          closeSession(session.id);
        });
      };

      connectToCandidate();
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
