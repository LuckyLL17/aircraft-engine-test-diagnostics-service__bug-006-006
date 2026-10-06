import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { diagnosticService } from '../application/diagnostic-service.ts';
import { DomainError } from '../domain/errors.ts';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

async function readBody(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new DomainError('REQUEST_TOO_LARGE', 'JSON request exceeds the 4 MiB limit', 413);
    chunks.push(buffer);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new DomainError('INVALID_JSON', 'Request body must be valid JSON', 400); }
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
}

export function createServer() {
  return createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/health') return send(response, 200, { status: 'ok', service: 'aircraft-engine-test-diagnostics-service' });
      if (request.method !== 'POST') return send(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST for diagnostic endpoints' } });
      const input = await readBody(request);
      const handlers: Record<string, () => unknown> = {
        '/v1/test-runs/analyze': () => diagnosticService.analyze(input),
        '/v1/timeline/replay': () => diagnosticService.replay(input.events ?? []),
        '/v1/performance/evaluate': () => diagnosticService.performance(input),
        '/v1/vibration/diagnose': () => diagnosticService.vibration(input.evidence ?? [], input.prior),
        '/v1/health/advance': () => diagnosticService.health(input.intervals ?? [], input.initial),
        '/v1/root-cause/infer': () => diagnosticService.rootCause(input.observations ?? [], input.edges ?? []),
        '/v1/life/estimate': () => diagnosticService.life(input),
      };
      const handler = handlers[url.pathname];
      if (!handler) return send(response, 404, { error: { code: 'NOT_FOUND', message: 'Unknown diagnostic endpoint' } });
      return send(response, 200, handler());
    } catch (error) {
      const domain = error instanceof DomainError ? error : new DomainError('INTERNAL_ERROR', error instanceof Error ? error.message : 'Unknown error', 500);
      return send(response, domain.status, { error: { code: domain.code, message: domain.message, details: domain.details } });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 4321);
  createServer().listen(port, '127.0.0.1', () => console.log(`aircraft engine service listening on http://127.0.0.1:${port}`));
}
