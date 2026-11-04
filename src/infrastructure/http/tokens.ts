/** Injection tokens. Ports are interfaces, so Nest needs an explicit key for each. */
export const APP_CONFIG = Symbol('APP_CONFIG');
export const ORM = Symbol('ORM');
export const SQS_CLIENT = Symbol('SQS_CLIENT');
export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
export const CLOCK = Symbol('CLOCK');
export const METRICS = Symbol('METRICS');
export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');
export const DEPENDENCY_PROBES = Symbol('DEPENDENCY_PROBES');
export const LOGGER = Symbol('LOGGER');
export const METRICS_REGISTRY = Symbol('METRICS_REGISTRY');
