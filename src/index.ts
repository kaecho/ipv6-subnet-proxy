import { loadConfig } from './config';
import { initLogger, getLogger } from './utils/logger';
import { getDb, closeDb } from './database/connection';
import { runMigrations } from './database/migrations';
import { createSocks5Server } from './socks5/server';
import { createApiServer } from './api/server';
import { addSubnet, getSubnetByCidr, bindSubnetToAllUsers, pruneSubnetsBySource } from './core/subnets';
import { startTunnel, stopTunnel, startEndpointWatcher } from './core/tunnel';
import { startWarp, stopWarp } from './core/warp';
import { detectIPv6Subnets, unregisterAllIPv6Addresses, ensureNonlocalBind } from './utils/ipv6';

/**
 * Register a subnet the proxy brought up itself, and make sure everyone can
 * use it. Existing users are only auto-bound at creation time, so a subnet that
 * appears later — a WARP link, a tunnel prefix — has to be handed to them here.
 */
function registerManagedSubnet(cidr: string, source: string): void {
  const log = getLogger();
  try {
    const subnet = getSubnetByCidr(cidr) ?? addSubnet(cidr, undefined, source);
    const boundUsers = bindSubnetToAllUsers(subnet.id);
    log.info({ cidr: subnet.cidr, source, boundUsers }, 'Registered IPv6 subnet');
  } catch (err: any) {
    log.warn({ cidr, source, err: err.message }, 'Failed to register subnet');
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  initLogger(config.logLevel);
  const log = getLogger();

  log.info('Starting IPv6 Subnet Proxy...');

  // Binding a session's source address out of a routed prefix must work even
  // when that /128 is not configured on an interface. Best effort: containers
  // with a read-only /proc have to set this on the host.
  if (!ensureNonlocalBind()) {
    log.warn(
      'net.ipv6.ip_nonlocal_bind is not enabled and could not be set. ' +
        'Sessions cannot bind non-local IPv6 addresses until the host runs: ' +
        'sysctl -w net.ipv6.ip_nonlocal_bind=1'
    );
  }

  // Database
  const db = getDb(config.dbPath);
  runMigrations(db);
  log.info({ dbPath: config.dbPath }, 'Database initialized');

  // Bring up the 6in4 tunnel first: on a host with no IPv6 of its own, the
  // prefix it carries is the only thing there is to allocate from.
  const tunnel = await startTunnel(config.tunnel);
  const tunnelPrefixes = tunnel.up && config.tunnel.registerSubnets
    ? tunnel.spec?.routedPrefixes ?? []
    : [];
  if (tunnel.enabled) {
    startEndpointWatcher(config.tunnel);
  }

  // Cloudflare WARP: free IPv6 over WireGuard, one address per registered
  // device. Independent of the 6in4 tunnel — a host can run either or both.
  const warp = await startWarp(config.warp);
  const warpCidrs = warp.up && config.warp.registerSubnets ? warp.cidrs : [];

  // Auto-detect only when DEFAULT_SUBNET is not set (env is authoritative).
  let detectedSubnets: string[] = [];
  if (!config.defaultSubnet) {
    log.info('Scanning network interfaces for IPv6 subnets...');
    // The tunnel link prefix shows up as an interface subnet, but only our one
    // endpoint address in it is ours; the routed prefixes are the pool.
    detectedSubnets = detectIPv6Subnets(tunnel.spec ? [tunnel.spec.linkPrefix] : []);
    log.info({ count: detectedSubnets.length, subnets: detectedSubnets },
      detectedSubnets.length > 0
        ? 'IPv6 subnet detection complete'
        : 'No IPv6 subnets detected on host interfaces');

    for (const cidr of detectedSubnets) {
      registerManagedSubnet(cidr, 'detected');
    }
  } else {
    log.info({ cidr: config.defaultSubnet }, 'DEFAULT_SUBNET set; skipping interface auto-detect');
  }

  // Also register default subnet from env if provided (supplementary)
  if (config.defaultSubnet) {
    try {
      const subnet =
        getSubnetByCidr(config.defaultSubnet) ??
        addSubnet(config.defaultSubnet, config.defaultSubnetGateway || undefined, 'env');
      bindSubnetToAllUsers(subnet.id);
      log.info({ cidr: subnet.cidr }, 'Default subnet from env registered');
    } catch (err: any) {
      log.warn({ err: err.message }, 'Failed to register default subnet');
    }
  }

  // Prefixes routed to the tunnel — registered regardless of DEFAULT_SUBNET,
  // since the broker routes them here and nothing else can claim them.
  for (const cidr of tunnelPrefixes) {
    registerManagedSubnet(cidr, 'tunnel');
  }

  // Each WARP link contributes exactly one address, registered as a /128
  // subnet. Users in `random` mode then rotate across them connection by
  // connection, the same way they would across several /64s.
  for (const cidr of warpCidrs) {
    registerManagedSubnet(cidr, 'warp');
  }

  // Re-registering WARP devices produces new addresses; the ones they replaced
  // no longer route, so they must not stay in the allocation pool. Only done
  // when WARP is actually up, so a failed bring-up does not discard a working
  // pool that might come back on the next restart.
  if (warp.up && config.warp.registerSubnets) {
    const pruned = pruneSubnetsBySource('warp', warpCidrs);
    if (pruned.length > 0) {
      log.info({ count: pruned.length, cidrs: pruned }, 'Dropped WARP addresses that are no longer assigned');
    }
  }

  if (
    detectedSubnets.length === 0 &&
    tunnelPrefixes.length === 0 &&
    warpCidrs.length === 0 &&
    !config.defaultSubnet
  ) {
    log.warn('No IPv6 subnets detected and no DEFAULT_SUBNET configured. ' +
      'Users will not be able to make proxied connections until a subnet is added. ' +
      'A host without IPv6 can get IPv6 for free two ways: a routed prefix from a tunnel ' +
      'broker (HE_TUNNEL_*), or Cloudflare WARP (WARP_ENABLED=true) — see the README.');
  }

  // SOCKS5
  const socks5Server = createSocks5Server(config.socks5Port);
  socks5Server.listen(config.socks5Port, () => {
    log.info({ port: config.socks5Port }, 'SOCKS5 server listening');
  });

  // API
  const apiServer = await createApiServer();
  await apiServer.listen({ port: config.apiPort, host: config.apiHost });
  log.info({ port: config.apiPort, host: config.apiHost }, 'API server listening');

  // Graceful shutdown
  const shutdown = (signal: string) => {
    log.info({ signal }, 'Shutting down...');
    socks5Server.close();
    apiServer.close().then(() => {
      unregisterAllIPv6Addresses();
      // After the addresses, so their removal still finds the tunnel device.
      stopTunnel();
      stopWarp();
      closeDb();
      log.info('Shutdown complete');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
