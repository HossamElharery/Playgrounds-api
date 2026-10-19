import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import type { App } from 'supertest/types';
import { configureApp } from '../src/bootstrap';
import { AppModule } from '../src/modules/app/app.module';
import { PrismaService } from '../src/modules/prisma/prisma.service';

describe('player account lifecycle (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const email = 'account-lifecycle-e2e@matchena.test';
  const password = 'DeleteMe123!';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    await prisma.countryConfig.upsert({
      where: { code: 'EG' },
      update: {},
      create: {
        code: 'EG', nameEn: 'Egypt', nameAr: 'مصر', currency: 'EGP',
        phoneCallingCode: '+20', timezone: 'Africa/Cairo', locale: 'ar',
        paymentMethods: ['cash'],
      },
    });
    await prisma.user.deleteMany({ where: { email } });
    await prisma.user.create({
      data: {
        email,
        emailVerifiedAt: new Date(),
        name: 'Account Lifecycle QA',
        passwordHash: await bcrypt.hash(password, 4),
        roles: ['player'],
        status: 'active',
        countryCode: 'EG',
      },
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('logs in, deletes the account, and rejects a later login', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(201);
    const accessToken = login.body.result.accessToken as string;
    expect(accessToken).toBeTruthy();

    await request(app.getHttpServer())
      .delete('/api/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect((response) => expect(response.body.result).toEqual({ deleted: true }));

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(401);

    const deleted = await prisma.user.findFirst({
      where: { name: 'Deleted user', deletedAt: { not: null } },
      orderBy: { deletedAt: 'desc' },
      select: {
        email: true, phone: true, username: true, passwordHash: true,
        status: true, deletedAt: true,
      },
    });
    expect(deleted).toEqual({
      email: null,
      phone: null,
      username: null,
      passwordHash: null,
      status: 'suspended',
      deletedAt: expect.any(Date),
    });
  });
});
