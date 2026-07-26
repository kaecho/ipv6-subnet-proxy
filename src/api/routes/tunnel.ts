import { FastifyInstance } from 'fastify';
import {
  getTunnelState,
  getTunnelConfig,
  reconnectTunnel,
  verifyTunnel,
} from '../../core/tunnel';
import { updateTunnelEndpoint, detectPublicIPv4 } from '../../core/tunnelbroker';
import { logAction } from '../../core/audit';

export function registerTunnelRoutes(app: FastifyInstance): void {
  /** What the 6in4 tunnel is doing right now, and why it is not working if it isn't. */
  app.get('/tunnel', async () => {
    const state = getTunnelState();
    const cfg = getTunnelConfig();
    return {
      ...state,
      config: cfg
        ? {
            device: cfg.device,
            tunnelId: cfg.tunnelId,
            routeTable: cfg.routeTable,
            defaultRoute: cfg.defaultRoute,
            mtu: cfg.mtu,
            updateEndpoint: cfg.updateEndpoint,
            updateIntervalMs: cfg.updateIntervalMs,
            // Credentials are deliberately not echoed back.
            credentials: cfg.username ? 'configured' : 'none',
          }
        : null,
    };
  });

  /** Re-probe: does traffic actually pass over the tunnel? */
  app.post('/tunnel/verify', async (request, reply) => {
    const state = getTunnelState();
    const cfg = getTunnelConfig();
    if (!cfg || !state.spec) {
      return reply.code(409).send({ error: 'Conflict', message: 'No tunnel is configured' });
    }
    const probes = await verifyTunnel(state.spec, cfg);
    state.probes = probes;
    return { ok: probes.some((p) => p.ok), probes };
  });

  /** Point the tunnel at this host's current public IPv4. */
  app.post('/tunnel/endpoint', async (request, reply) => {
    const cfg = getTunnelConfig();
    if (!cfg || !cfg.tunnelId) {
      return reply.code(409).send({ error: 'Conflict', message: 'HE_TUNNEL_ID is not configured' });
    }

    const publicIpv4 = await detectPublicIPv4(cfg).catch(() => null);
    const result = await updateTunnelEndpoint(cfg, publicIpv4);
    const state = getTunnelState();
    state.endpointUpdate = { ...result, at: new Date().toISOString() };
    if (result.ok && result.ip) state.publicIpv4 = result.ip;

    logAction('tunnel.endpoint_updated', { code: result.code, ip: result.ip });
    return reply.code(result.ok ? 200 : 502).send({ ...result, publicIpv4 });
  });

  /** Tear the tunnel down and build it again from current settings. */
  app.post('/tunnel/reconnect', async (request, reply) => {
    const cfg = getTunnelConfig();
    if (!cfg || !cfg.enabled) {
      return reply.code(409).send({ error: 'Conflict', message: 'Tunnel support is disabled' });
    }

    const state = await reconnectTunnel();
    logAction('tunnel.reconnected', { up: state.up, device: state.device });
    return reply.code(state.up ? 200 : 502).send(state);
  });
}
