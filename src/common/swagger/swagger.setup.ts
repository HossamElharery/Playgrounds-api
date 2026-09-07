import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

const GUIDE = `
## How to test (for non-backend people)

1. Open an endpoint (start with **POST /api/v1/auth/login**).
2. Click **Try it out**.
3. Use the example JSON already filled in the body (do not send \`{}\`).
4. Click **Execute**.
5. Copy \`result.accessToken\` from the response.
6. Click **Authorize** at the top, paste: \`Bearer <token>\` or just the token, then Authorize.
7. Locked endpoints (lock icon) will now send your token automatically.

### Seed accounts (already in the database)

| Role | Email | Password |
| --- | --- | --- |
| Admin | \`admin@mal3ab.app\` | \`Password123!\` |
| Venue owner | \`owner@mal3ab.app\` | \`Password123!\` |

Player login is phone OTP: \`POST /auth/otp/request\` with \`"phone": "+201001234567"\`. In development the code is printed in the **API server terminal** (not returned in the HTTP response). Then \`POST /auth/otp/verify\` with that 4-digit code.

### Typical booking flow

1. \`GET /venues\` → copy a venue \`slug\`
2. \`GET /venues/{slug}\` → copy a \`courts[0].id\`
3. \`GET /courts/{courtId}/slots?date=2026-09-10\` → pick an \`available\` slot \`start\`
4. \`POST /bookings/hold\` with \`courtId\` + \`slotStart\`
5. \`POST /bookings/{id}/confirm\` with \`"paymentMethod": "card"\`

Money amounts are **piasters** (EGP × 100). Example: 25000 = 250 EGP.

All successful responses look like: \`{ "message": "...", "result": ... }\`.

### Query parameters (important)

Global validation **rejects unknown query fields** (\`property X should not exist\`).

- Leave optional params **empty** in Swagger if you do not need them. Do not type placeholder words like \`Active\`, \`string\`, or \`test\`.
- Blog **public** list (\`GET /blog\`) has **no status**. It always returns \`published\` posts. Filter drafts via **admin** \`GET /admin/blog?status=draft\`.
- Allowed status values are lowercase enums, never \`Active\`:
  - Blog: \`draft\` | \`published\` | \`archived\`
  - Support: \`new\` | \`read\`
  - Bookings: \`held\` | \`confirmed\` | \`cancelled\` | \`completed\` | \`no_show\`
  - Reports: \`open\` | \`resolved\` | \`dismissed\`
`;

export function setupSwagger(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('Mal3ab API')
    .setDescription(GUIDE)
    .setVersion('0.1.0')
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description:
        'Paste the accessToken from POST /api/v1/auth/login (Authorize button at the top).',
    })
    .addTag('auth', 'Login, OTP, register, refresh')
    .addTag('venues', 'Explore map search, venue details, owner courts')
    .addTag('bookings', 'Hold → confirm → cancel slots')
    .addTag('users', 'Profile, players directory, favorites')
    .addTag('social', 'Friends, match posts, teams')
    .addTag('chat', 'Threads and messages')
    .addTag('geo', 'Countries, governorates, districts')
    .addTag('content', 'Sports, blog, FAQ, support')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, {
    customSiteTitle: 'Mal3ab API — Try it out',
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
      filter: true,
      tryItOutEnabled: true,
      docExpansion: 'list',
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
      defaultModelsExpandDepth: 2,
      defaultModelExpandDepth: 2,
    },
  });
}
