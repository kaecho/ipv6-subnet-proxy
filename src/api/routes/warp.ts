import { FastifyInstance } from 'fastify';
import {
  getWarpState,
  getWarpConfig,
  listStoredAccounts,
  reconnectWarp,
  verifyWarp,
} from '../../core/warp';
import { logAction } from '../../core/audit';

export function registerWarpRoutes(app: FastifyInstance): void {
  /** What the WARP links are doing right now, and why they are not working if they aren't. */
  app.get('/warp', async () => {
    const state = getWarpState();
    const cfg = getWarpConfig();
    return {
      ...state,
      config: cfg
        ? {
            accounts: cfg.accounts,
            devicePrefix: cfg.devicePrefix,
            routeTable: cfg.routeTable,
            mtu: cfg.mtu,
            endpoint: cfg.endpoint,
            registerSubnets: cfg.registerSubnets,
            // Private keys and device tokens are deliberately not echoed back.
            license: cfg.license ? 'configured' : 'none',
          }
        : null,
    };
  });

  /**
   * The registered devices, without their secrets. Useful for confirming that
   * a restart reused the same addresses rather than registering new ones.
   */
  app.get('/warp/accounts', async () => {
    return listStoredAccounts().map((account) => ({
      slot: account.slot,
      deviceId: account.deviceId,
      accountType: account.accountType,
      addressV6: account.addressV6,
      addressV4: account.addressV4,
      endpointHost: account.endpointHost,
      publicKey: account.publicKey,
      reserved: account.reserved,
    }));
  });

  /** Re-probe: does traffic actually pass over each link? */
  app.post('/warp/verify', async (request, reply) => {
    const cfg = getWarpConfig();
    const state = getWarpState();
    if (!cfg || !state.up) {
      return reply.code(409).send({ error: 'Conflict', message: 'No WARP link is up' });
    }
    const probes = await verifyWarp(cfg, state);
    return { ok: probes.some((p) => p.ok), probes };
  });

  /** Tear the links down and build them again from the stored registrations. */
  app.post('/warp/reconnect', async (request, reply) => {
    const cfg = getWarpConfig();
    if (!cfg || !cfg.enabled) {
      return reply.code(409).send({ error: 'Conflict', message: 'WARP support is disabled' });
    }

    const state = await reconnectWarp();
    logAction('warp.reconnected', { up: state.up, links: state.links.length });
    return reply.code(state.up ? 200 : 502).send(state);
  });
}
