export interface YjsServerConfig {
    host: string;
    port: number;
    dbPath: string;
    laravelDbPath: string;
    jwtSecret: string;
    jwtIssuer: string;
    jwtAudience: string;
    internalToken: string;
    debounce: number;
    maxDebounce: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
    const value = env[name];

    if (!value) {
        throw new Error(`Missing required environment variable ${name}`);
    }

    return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): YjsServerConfig {
    return {
        host: env.YJS_HOST ?? '0.0.0.0',
        port: Number.parseInt(env.YJS_PORT ?? '1234', 10),
        dbPath: required(env, 'YJS_DB_PATH'),
        laravelDbPath: required(env, 'LARAVEL_DB_PATH'),
        jwtSecret: required(env, 'YJS_JWT_SECRET'),
        jwtIssuer: env.YJS_JWT_ISSUER ?? 'many-notes',
        jwtAudience: env.YJS_JWT_AUDIENCE ?? 'many-notes-yjs',
        internalToken: required(env, 'YJS_INTERNAL_TOKEN'),
        debounce: Number.parseInt(env.YJS_STORE_DEBOUNCE ?? '2000', 10),
        maxDebounce: Number.parseInt(env.YJS_STORE_MAX_DEBOUNCE ?? '10000', 10),
    };
}

export function assertConfig(config: YjsServerConfig): void {
    if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
        throw new Error('YJS_PORT must be a valid port');
    }

    if (!Number.isFinite(config.debounce) || config.debounce < 0) {
        throw new Error('YJS_STORE_DEBOUNCE must be a positive number');
    }

    if (!Number.isFinite(config.maxDebounce) || config.maxDebounce < config.debounce) {
        throw new Error(
            'YJS_STORE_MAX_DEBOUNCE must be greater than or equal to YJS_STORE_DEBOUNCE'
        );
    }

    if (config.jwtSecret.length < 32) {
        throw new Error('YJS_JWT_SECRET must be at least 32 characters');
    }

    if (config.internalToken.length < 32) {
        throw new Error('YJS_INTERNAL_TOKEN must be at least 32 characters');
    }
}
