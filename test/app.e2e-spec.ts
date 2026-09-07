import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/modules/app/app.module';
import { configureApp } from '../src/bootstrap';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET / returns a health payload', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect((res) => {
        expect(res.body.result.status).toBe('ok');
        expect(res.body.result.service).toBe('mal3ab-api');
      });
  });

  it('GET /api/v1/users/me without a token is rejected', () => {
    return request(app.getHttpServer()).get('/api/v1/users/me').expect(401);
  });
});
