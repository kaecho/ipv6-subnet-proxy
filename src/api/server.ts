import Fastify, { FastifyInstance, FastifyBaseLogger } from 'fastify';
import { loadConfig } from '../config';
import { getLogger } from '../utils/logger';
import { apiKeyAuth } from './middleware/auth';
import { registerHealthRoutes } from './routes/health';
import { registerUserRoutes } from './routes/users';
import { registerSubnetRoutes } from './routes/subnets';
import { registerBindingRoutes } from './routes/bindings';
import { registerSessionRoutes } from './routes/sessions';
import { registerTrafficRoutes } from './routes/traffic';
import { registerLimitRoutes } from './routes/limits';
import { registerAuditRoutes } from './routes/audit';
import { registerResolverRoutes } from './routes/resolver';
import { registerTunnelRoutes } from './routes/tunnel';

export async function createApiServer(): Promise<FastifyInstance> {
  const config = loadConfig();
  const log = getLogger();

  const app = Fastify({ logger: log as unknown as FastifyBaseLogger, disableRequestLogging: false });

  app.setErrorHandler((error, request, reply) => {
    log.error({ err: error.message, url: request.url }, 'API error');
    reply.code(error.statusCode || 500).send({
      error: error.name || 'InternalServerError',
      message: error.message || 'An unexpected error occurred',
    });
  });

  // Health routes (no auth)
  registerHealthRoutes(app);

  // Auth hook for all other routes
  app.addHook('onRequest', async (request, reply) => {
    // Skip auth for health endpoints — use routerPath to avoid query-string mismatch
    const path = request.routerPath || request.url?.split('?')[0];
    if (path === '/health' || path === '/health/ready') return;
    await apiKeyAuth(request, reply);
  });

  // Protected route groups under /api/v1
  await app.register(async (v1) => {
    registerUserRoutes(v1);
    registerSubnetRoutes(v1);
    registerBindingRoutes(v1);
    registerSessionRoutes(v1);
    registerTrafficRoutes(v1);
    registerLimitRoutes(v1);
    registerAuditRoutes(v1);
    registerResolverRoutes(v1);
    registerTunnelRoutes(v1);
  }, { prefix: '/api/v1' });

  return app;
}
