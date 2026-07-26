import { FastifyInstance } from 'fastify';
import { inspectHost, getResolverStats, clearRouteCache } from '../../core/target-resolver';

export function registerResolverRoutes(app: FastifyInstance): void {
  /**
   * Diagnose how (or whether) a hostname is reachable over IPv6 — the
   * equivalent of running scripts/check-ipv6.sh against the live proxy.
   */
  app.get('/resolver/check', async (request, reply) => {
    const { host, port } = (request.query || {}) as { host?: string; port?: string };
    if (!host) {
      return reply.code(400).send({ error: 'BadRequest', message: 'host query parameter is required' });
    }

    const targetPort = port ? parseInt(port, 10) : 443;
    if (isNaN(targetPort) || targetPort < 1 || targetPort > 65535) {
      return reply.code(400).send({ error: 'BadRequest', message: 'port must be 1-65535' });
    }

    try {
      return await inspectHost(host, targetPort);
    } catch (err: any) {
      return reply.code(400).send({ error: 'BadRequest', message: err.message });
    }
  });

  app.get('/resolver/cache', async () => getResolverStats());

  app.delete('/resolver/cache', async () => ({ success: true, cleared: clearRouteCache() }));
}
