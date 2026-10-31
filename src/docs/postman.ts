import type { OpenAPIObject } from '@nestjs/swagger';

interface SchemaLike {
  type?: string;
  example?: unknown;
  properties?: Record<string, SchemaLike>;
  required?: string[];
  $ref?: string;
}

interface OperationLike {
  tags?: string[];
  summary?: string;
  description?: string;
  requestBody?: { content?: Record<string, { schema?: SchemaLike }> };
  parameters?: { name: string; in: string; example?: unknown; schema?: SchemaLike }[];
}

interface PostmanItem {
  name: string;
  request: {
    method: string;
    header: { key: string; value: string }[];
    url: {
      raw: string;
      host: string[];
      path: string[];
      query?: { key: string; value: string; disabled: boolean }[];
    };
    body?: { mode: 'raw'; raw: string; options: { raw: { language: 'json' } } };
    description?: string;
  };
  event?: { listen: 'test'; script: { type: 'text/javascript'; exec: string[] } }[];
}

/** Folders in the order a first run needs them: wallets and funds before anything that spends. */
const FOLDER_ORDER = ['wallets', 'deposits', 'swaps', 'transfers', 'fx', 'transactions', 'admin'];

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** What a request's test script stores for later requests: collection variable <- response field. */
const SAVES: Record<string, { variable: string; path: string }[]> = {
  'POST /v1/wallets': [{ variable: 'wallet_id', path: 'id' }],
  'POST /v1/wallets/{id}/deposits': [{ variable: 'transaction_id', path: 'transaction.id' }],
  'POST /v1/wallets/{id}/swaps': [{ variable: 'transaction_id', path: 'transaction.id' }],
  'POST /v1/wallets/{id}/transfers': [{ variable: 'transaction_id', path: 'transaction.id' }],
  'POST /v1/fx/quotes': [{ variable: 'quote_id', path: 'quote_id' }],
};

/** Request bodies that need values the OpenAPI examples cannot know (ids saved by earlier requests). */
const BODY_OVERRIDES: Record<string, Record<string, string>> = {
  'POST /v1/wallets/{id}/deposits': { amount: '1000000' },
  'POST /v1/wallets/{id}/transfers': { to_wallet_id: '{{wallet_id_b}}' },
  'POST /v1/fx/quotes': { wallet_id: '{{wallet_id}}' },
};

function bodyFor(
  key: string,
  schema: SchemaLike | undefined,
  doc: OpenAPIObject,
): string | undefined {
  if (!schema) return undefined;
  const resolved = schema.$ref ? resolveRef(schema.$ref, doc) : schema;
  const body: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(resolved?.properties ?? {})) {
    if (prop.example !== undefined) body[name] = prop.example;
  }
  Object.assign(body, BODY_OVERRIDES[key]);
  // An example quote_id never exists: swaps and transfers run at the current rate unless one is added.
  delete body['quote_id'];
  return JSON.stringify(body, null, 2);
}

function resolveRef(ref: string, doc: OpenAPIObject): SchemaLike | undefined {
  const name = ref.split('/').pop() ?? '';
  return doc.components?.schemas?.[name];
}

function pathFor(path: string): string[] {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      if (segment !== '{id}') return segment;
      return path.startsWith('/v1/transactions') ? '{{transaction_id}}' : '{{wallet_id}}';
    });
}

function testScript(key: string, expectedStatus: number): string[] {
  const lines = [
    `pm.test('status is ${expectedStatus}', () => pm.response.to.have.status(${expectedStatus}));`,
  ];
  const saves = SAVES[key] ?? [];
  if (saves.length > 0) lines.push('const body = pm.response.json();');
  for (const save of saves) {
    lines.push(
      `pm.collectionVariables.set('${save.variable}', ${save.path.split('.').reduce((acc, part) => `${acc}.${part}`, 'body')});`,
    );
  }
  return lines;
}

/**
 * Builds a Postman collection from the OpenAPI document: one folder per tag, a `baseUrl`
 * variable, a fresh `Idempotency-Key` per request and test scripts that save ids for later calls.
 */
export function buildPostmanCollection(doc: OpenAPIObject): unknown {
  const folders = new Map<string, PostmanItem[]>();

  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const operation = (item as Record<string, OperationLike | undefined>)[method];
      if (!operation) continue;
      const key = `${method.toUpperCase()} ${path}`;
      const needsKey = (operation.parameters ?? []).some(
        (p) => p.in === 'header' && p.name === 'Idempotency-Key',
      );
      const schema = operation.requestBody?.content?.['application/json']?.schema;
      const body = method === 'get' ? undefined : bodyFor(key, schema, doc);
      const segments = pathFor(path);
      const queries = (operation.parameters ?? [])
        .filter((p) => p.in === 'query')
        .map((p) => ({
          key: p.name,
          value: typeof p.example === 'string' ? p.example : '',
          disabled: true,
        }));
      const expected = method === 'post' && !path.startsWith('/v1/admin') ? 201 : 200;

      const request: PostmanItem = {
        name: operation.summary ?? key,
        request: {
          method: method.toUpperCase(),
          header: [
            ...(body ? [{ key: 'Content-Type', value: 'application/json' }] : []),
            ...(needsKey ? [{ key: 'Idempotency-Key', value: '{{$guid}}' }] : []),
          ],
          url: {
            raw: `{{baseUrl}}/${segments.join('/')}`,
            host: ['{{baseUrl}}'],
            path: segments,
            ...(queries.length > 0 ? { query: queries } : {}),
          },
          ...(body
            ? { body: { mode: 'raw', raw: body, options: { raw: { language: 'json' } } } }
            : {}),
          ...(operation.description ? { description: operation.description } : {}),
        },
        event: [
          { listen: 'test', script: { type: 'text/javascript', exec: testScript(key, expected) } },
        ],
      };

      const tag = operation.tags?.[0] ?? 'other';
      folders.set(tag, [...(folders.get(tag) ?? []), request]);

      // A second wallet is needed as a transfer recipient: same request, saves wallet_id_b.
      if (key === 'POST /v1/wallets') {
        folders.set(tag, [
          ...(folders.get(tag) ?? []),
          {
            ...request,
            name: 'Create a second wallet (transfer recipient)',
            request: {
              ...request.request,
              body: {
                mode: 'raw',
                raw: JSON.stringify({ email: 'recipient@example.com' }, null, 2),
                options: { raw: { language: 'json' } },
              },
            },
            event: [
              {
                listen: 'test',
                script: {
                  type: 'text/javascript',
                  exec: [
                    "pm.test('status is 201', () => pm.response.to.have.status(201));",
                    "pm.collectionVariables.set('wallet_id_b', pm.response.json().id);",
                  ],
                },
              },
            ],
          },
        ]);
      }
    }
  }

  return {
    info: {
      name: 'Operation Borderless API',
      description:
        'Generated from openapi.json by `yarn openapi:export`. Run "Create a wallet" first: it saves wallet_id; the transfer needs "Create a second wallet" as well.',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    variable: [
      { key: 'baseUrl', value: 'http://localhost:3000' },
      { key: 'wallet_id', value: '' },
      { key: 'wallet_id_b', value: '' },
      { key: 'transaction_id', value: '' },
      { key: 'quote_id', value: '' },
    ],
    item: FOLDER_ORDER.filter((name) => folders.has(name)).map((name) => ({
      name,
      // The latest reconciliation only exists after a run, so run first.
      item: name === 'admin' ? [...(folders.get(name) ?? [])].reverse() : (folders.get(name) ?? []),
    })),
  };
}
