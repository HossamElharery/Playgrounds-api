import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  emit(name: string, userId: string | undefined, payload?: Record<string, unknown>) {
    void this.prisma.analyticsEvent
      .create({ data: { name, userId, payload: payload as object | undefined } })
      .catch(() => undefined);
  }
}
