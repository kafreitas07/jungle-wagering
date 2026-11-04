import 'reflect-metadata';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { type DynamicModule, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { type Clock, type LoggerPort, type MetricsPort, NoopLogger, NoopMetrics, type ProviderIdentityPort, SystemClock, type UnitOfWork } from '../application/ports';
import type { AppConfig } from './config/env';
import { type DependencyProbe, PostgresProbe, SqsProbe } from './health/dependency-probes';
import { GetTransactionByExternalId, GetTransactionById, GetWallet } from '../application/use-cases/queries';
import { ListLedger } from '../application/use-cases/list-ledger';
import { ReconcileWallet } from '../application/use-cases/reconcile-wallet';
import { OpenWallet } from '../application/use-cases/open-wallet';
import { SubmitWagerTransaction } from '../application/use-cases/submit-wager-transaction';
import { ConcurrencyRetry } from '../application/services/concurrency-retry';
import { AllowAllProviderIdentity } from './http/auth/allow-all-provider-identity';
import { AuthGuard } from './http/auth/auth.guard';
import { ReconciliationController } from './http/controllers/reconciliation.controller';
import { WageringController } from './http/controllers/wagering.controller';
import { WalletsController } from './http/controllers/wallets.controller';
import { HealthController } from './http/health.controller';
import {
  APP_CONFIG,
  CLOCK,
  DEPENDENCY_PROBES,
  LOGGER,
  METRICS,
  ORM,
  PROVIDER_IDENTITY,
  SQS_CLIENT,
  UNIT_OF_WORK,
} from './http/tokens';
import { createSqsClient } from './messaging/sqs-client';
import { createOrmConfig } from './persistence/orm.config';
import { MikroOrmUnitOfWork } from './persistence/unit-of-work';

/** Pieces a test (or a real deployment) may swap without touching the module. */
export interface AppOverrides {
  readonly providerIdentity?: ProviderIdentityPort;
  readonly clock?: Clock;
  readonly metrics?: MetricsPort;
  readonly logger?: LoggerPort;
}

class Lifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.sqs.destroy();
    await this.orm.close();
  }
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig, overrides: AppOverrides = {}): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, WalletsController, ReconciliationController, WageringController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: ORM, useFactory: () => MikroORM.init(createOrmConfig(config.database)) },
        { provide: SQS_CLIENT, useFactory: () => createSqsClient(config.sqs) },
        { provide: CLOCK, useValue: overrides.clock ?? new SystemClock() },
        { provide: LOGGER, useValue: overrides.logger ?? new NoopLogger() },
        { provide: METRICS, useValue: overrides.metrics ?? new NoopMetrics() },
        {
          provide: UNIT_OF_WORK,
          inject: [ORM],
          useFactory: (orm: MikroORM): UnitOfWork => new MikroOrmUnitOfWork(orm, { lockTimeoutMs: config.database.lockTimeoutMs }),
        },
        {
          provide: DEPENDENCY_PROBES,
          inject: [ORM, SQS_CLIENT],
          useFactory: (orm: MikroORM, sqs: SQSClient): DependencyProbe[] => [
            new PostgresProbe(orm),
            new SqsProbe(sqs, [config.sqs.wagerQueue, config.sqs.eventsQueue]),
          ],
        },
        { provide: PROVIDER_IDENTITY, useValue: overrides.providerIdentity ?? new AllowAllProviderIdentity() },
        AuthGuard,
        {
          provide: OpenWallet,
          inject: [UNIT_OF_WORK, CLOCK],
          useFactory: (unitOfWork: UnitOfWork, clock: Clock) => new OpenWallet({ unitOfWork, clock }),
        },
        {
          provide: SubmitWagerTransaction,
          inject: [UNIT_OF_WORK, CLOCK, METRICS],
          useFactory: (unitOfWork: UnitOfWork, clock: Clock, metrics: MetricsPort) =>
            new SubmitWagerTransaction({
              unitOfWork,
              clock,
              referencePolicy: config.pendingReference,
              concurrencyRetry: new ConcurrencyRetry({ metrics }),
            }),
        },
        {
          provide: ReconcileWallet,
          inject: [UNIT_OF_WORK, LOGGER, METRICS],
          useFactory: (unitOfWork: UnitOfWork, logger: LoggerPort, metrics: MetricsPort) => new ReconcileWallet({ unitOfWork, logger, metrics }),
        },
        { provide: GetWallet, inject: [UNIT_OF_WORK], useFactory: (unitOfWork: UnitOfWork) => new GetWallet({ unitOfWork }) },
        { provide: ListLedger, inject: [UNIT_OF_WORK], useFactory: (unitOfWork: UnitOfWork) => new ListLedger({ unitOfWork }) },
        { provide: GetTransactionById, inject: [UNIT_OF_WORK], useFactory: (unitOfWork: UnitOfWork) => new GetTransactionById({ unitOfWork }) },
        {
          provide: GetTransactionByExternalId,
          inject: [UNIT_OF_WORK],
          useFactory: (unitOfWork: UnitOfWork) => new GetTransactionByExternalId({ unitOfWork }),
        },
        Lifecycle,
      ],
    };
  }
}
