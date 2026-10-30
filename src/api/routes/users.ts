import { FastifyInstance } from 'fastify';
import {
  createUser, getUser, listUsers, updateUser, deleteUser,
} from '../../core/users';
import { refreshUserStickyBindings, getCurrentStickyAddress } from '../../core/ip-allocator';
import { logAction } from '../../core/audit';

const MODE_REMOVED_MESSAGE =
  'The mode field is no longer supported; append -random or -sticky (optionally -sticky-<key>) to the SOCKS5 username instead';

export function registerUserRoutes(app: FastifyInstance): void {
  app.post('/users', async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply.code(400).send({ error: 'BadRequest', message: 'A JSON object body is required' });
    }
    if ('mode' in body) {
      return reply.code(400).send({ error: 'BadRequest', message: MODE_REMOVED_MESSAGE });
    }
    const username = 'username' in body && typeof body.username === 'string' ? body.username : '';
    const password = 'password' in body && typeof body.password === 'string' ? body.password : '';
    if (!username || !password) {
      return reply.code(400).send({ error: 'BadRequest', message: 'username and password are required' });
    }
    try {
      const user = createUser({ username, password });
      logAction('user.created', { username }, user.id);
      reply.code(201).send(user);
    } catch (err: any) {
      if (err.message?.includes('UNIQUE constraint')) {
        return reply.code(409).send({ error: 'Conflict', message: 'Username already exists' });
      }
      throw err;
    }
  });

  app.get('/users', async () => listUsers());

  app.get('/users/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = getUser(id);
    if (!user) return reply.code(404).send({ error: 'NotFound', message: 'User not found' });
    return user;
  });

  app.patch('/users/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply.code(400).send({ error: 'BadRequest', message: 'A JSON object body is required' });
    }
    if ('mode' in body) {
      return reply.code(400).send({ error: 'BadRequest', message: MODE_REMOVED_MESSAGE });
    }

    const password = 'password' in body && typeof body.password === 'string'
      ? body.password
      : undefined;
    if ('password' in body && password === undefined) {
      return reply.code(400).send({ error: 'BadRequest', message: 'password must be a string' });
    }
    const status = 'status' in body && (body.status === 'active' || body.status === 'disabled')
      ? body.status
      : undefined;
    if ('status' in body && status === undefined) {
      return reply.code(400).send({ error: 'BadRequest', message: 'status must be active or disabled' });
    }

    try {
      const user = updateUser(id, { password, status });
      const safeInput = { password: password === undefined ? undefined : '[redacted]', status };
      logAction('user.updated', safeInput, id);
      return user;
    } catch (err: any) {
      if (err.message?.includes('not found')) {
        return reply.code(404).send({ error: 'NotFound', message: err.message });
      }
      throw err;
    }
  });

  app.delete('/users/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = getUser(id);
    if (!user) return reply.code(404).send({ error: 'NotFound', message: 'User not found' });
    deleteUser(id);
    logAction('user.deleted', { username: user.username }, id);
    reply.code(204).send();
  });

  app.post('/users/:id/refresh', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = getUser(id);
    if (!user) return reply.code(404).send({ error: 'NotFound', message: 'User not found' });

    const bindings = refreshUserStickyBindings(id);
    logAction('ip.refreshed', { bindings }, id);
    return {
      success: true,
      bindings,
      message: `Refreshed ${bindings} sticky IPv6 binding(s)`,
    };
  });

  app.get('/users/:id/current-ip', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = getUser(id);
    if (!user) return reply.code(404).send({ error: 'NotFound', message: 'User not found' });
    return { userId: id, addresses: getCurrentStickyAddress(id) };
  });
}
