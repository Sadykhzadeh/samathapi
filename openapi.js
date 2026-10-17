// The OpenAPI description of the server, built from the limits and settings
// the server itself runs on, so it cannot say 2 to 12 where the code says
// something else.
export const buildSpec = ({ version, lengthMin, lengthMax, countMax, seedMax, config }) => {
  const error = (description) => ({
    description,
    content: {
      'application/json': { schema: { $ref: '#/components/schemas/Error' } },
      'text/plain': { schema: { type: 'string' } },
    },
  });

  return {
    openapi: '3.0.3',
    info: {
      title: 'SaMath API',
      description: 'Math tasks with a worked-out answer and four choices, for quizzes and worksheets.',
      version,
    },
    paths: {
      '/': {
        get: {
          summary: 'Greeting',
          responses: { 200: { description: 'Hello World', content: { 'text/plain': { schema: { type: 'string' } } } } },
        },
      },
      '/healthz': {
        get: {
          summary: 'Whether the server is up',
          responses: {
            200: {
              description: 'The server answers',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['ok'],
                    properties: { ok: { type: 'boolean', enum: [true] } },
                  },
                },
              },
            },
          },
        },
      },
      '/openapi.json': {
        get: {
          summary: 'This description',
          responses: { 200: { description: 'An OpenAPI 3 document', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/gen': {
        get: {
          summary: 'Generate one task, or a whole quiz with count',
          description: [
            'Every task works out to its answer with whole numbers only, * and / before + and -.',
            'Without c the format follows the Accept header: text/plain asks for the line SaMathCLI parses,',
            'anything else gets JSON. With a seed the answer is the same every time.',
          ].join(' '),
          parameters: [
            {
              name: 'c',
              in: 'query',
              description: 'true for the plain-text line "<task> <opt1>,<opt2>,<opt3>,<opt4> <answer>", one per task; anything else for JSON. Decides over Accept.',
              schema: { type: 'string', enum: ['true', 'false'] },
            },
            {
              name: 'length',
              in: 'query',
              description: `How many numbers each task has. Without it every task draws a length from ${config.lengthFrom} to ${config.lengthTo}.`,
              schema: { type: 'integer', minimum: lengthMin, maximum: lengthMax },
            },
            {
              name: 'brackets',
              in: 'query',
              description: 'Wrap part of the task in brackets.',
              schema: { type: 'boolean', default: config.brackets },
            },
            {
              name: 'negatives',
              in: 'query',
              description: 'Allow a number below zero in a task or on the way to its answer. false is for a class that has not met them.',
              schema: { type: 'boolean', default: config.negatives },
            },
            {
              name: 'count',
              in: 'query',
              description: 'How many tasks. The answer is then a list, also for 1; without it the answer is one task. No task comes twice in a list unless a seed is given.',
              schema: { type: 'integer', minimum: 1, maximum: countMax },
            },
            {
              name: 'seed',
              in: 'query',
              description: 'Makes the answer the same every time. Task i of a count is the task for seed + i, wrapping after the largest seed.',
              schema: { type: 'integer', minimum: 0, maximum: seedMax },
            },
          ],
          responses: {
            200: {
              description: 'The task, or a list of them with count',
              headers: {
                'Cache-Control': { description: 'public, max-age=3600 with a seed; no-store without.', schema: { type: 'string' } },
                ETag: { description: 'With a seed. A matching If-None-Match is answered with 304.', schema: { type: 'string' } },
              },
              content: {
                'application/json': {
                  schema: {
                    oneOf: [
                      { $ref: '#/components/schemas/Task' },
                      { type: 'array', items: { $ref: '#/components/schemas/Task' } },
                    ],
                  },
                },
                'text/plain': {
                  schema: { type: 'string', example: '2*1*10 16,20,18,19 20' },
                },
              },
            },
            304: { description: 'The If-None-Match tag of a seeded answer is current' },
            400: error('A parameter is wrong, misspelt or sent twice; the message names each one and what was sent'),
            500: error('A task could not be generated'),
          },
        },
      },
    },
    components: {
      schemas: {
        Task: {
          type: 'object',
          required: ['task', 'answer', 'quizOptions'],
          properties: {
            task: {
              type: 'array',
              description: 'The task in pieces; task.join("") is the text to show.',
              items: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
              example: [3, '*', 9, '*', 2, '/', '(4-1)'],
            },
            answer: { type: 'integer' },
            quizOptions: {
              type: 'array',
              description: 'Four whole numbers, one of them the answer, in no particular order.',
              items: { type: 'integer' },
              minItems: 4,
              maxItems: 4,
            },
          },
        },
        Error: {
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'string' } },
        },
      },
    },
  };
};
