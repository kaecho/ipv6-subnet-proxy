import { loadConfig } from './config';
import { initLogger, getLogger } from './utils/logger';
import { getDb, closeDb } from './database/connection';
import { runMigrations } from './database/migrations';
import { createSocks5Server } from './socks5/server';
import { createApiServer } from './api/server';
import { addSubnet } from './core/subnets';
import { detectIPv6Subnets, unregisterAllIPv6Addresses } from './utils/ipv6';

async function main(): Promise<void> {
  const config = loadConfig();
  initLogger(config.logLevel);
  const log = getLogger();

  log.info('Starting IPv6 Subnet Proxy...');

  // Database
  const db = getDb(config.dbPath);
  runMigrations(db);
  log.info({ dbPath: config.dbPath }, 'Database initialized');

  // Auto-detect only when DEFAULT_SUBNET is not set (env is authoritative).
  let detectedSubnets: string[] = [];
  if (!config.defaultSubnet) {
    log.info('Scanning network interfaces for IPv6 subnets...');
    detectedSubnets = detectIPv6Subnets();
    log.info({ count: detectedSubnets.length, subnets: detectedSubnets },
      detectedSubnets.length > 0
        ? 'IPv6 subnet detection complete'
        : 'No IPv6 subnets detected on host interfaces');

    for (const cidr of detectedSubnets) {
      try {
        addSubnet(cidr);
        log.info({ cidr }, 'Auto-registered detected IPv6 subnet');
      } catch (err: any) {
        if (err.message?.includes('UNIQUE constraint')) {
          log.info({ cidr }, 'Detected subnet already registered');
        } else {
          log.warn({ cidr, err: err.message }, 'Failed to register detected subnet');
        }
      }
    }
  } else {
    log.info({ cidr: config.defaultSubnet }, 'DEFAULT_SUBNET set; skipping interface auto-detect');
  }

  // Also register default subnet from env if provided (supplementary)
  if (config.defaultSubnet) {
    try {
      addSubnet(config.defaultSubnet, config.defaultSubnetGateway || undefined);
      log.info({ cidr: config.defaultSubnet }, 'Default subnet from env registered');
    } catch (err: any) {
      if (err.message?.includes('UNIQUE constraint')) {
        log.info({ cidr: config.defaultSubnet }, 'Default subnet already registered');
      } else {
        log.warn({ err: err.message }, 'Failed to register default subnet');
      }
    }
  }

  if (detectedSubnets.length === 0 && !config.defaultSubnet) {
    log.warn('No IPv6 subnets detected and no DEFAULT_SUBNET configured. ' +
      'Users will not be able to make proxied connections until a subnet is added.');
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
