import 'reflect-metadata';
import { Controller, Get, Injectable, Module } from '@nestjs/common';

@Injectable()
export class ClockService {
  now(): string {
    return new Date().toISOString();
  }
}

@Controller('health')
export class HealthController {
  // Constructor injection relies on emitDecoratorMetadata working under Bun.
  constructor(private readonly clock: ClockService) {}

  @Get('live')
  live(): { status: string; at: string } {
    return { status: 'ok', at: this.clock.now() };
  }
}

@Module({ controllers: [HealthController], providers: [ClockService] })
export class SpikeAppModule {}
