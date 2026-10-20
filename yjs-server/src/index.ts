/* eslint-disable no-console */
import { loadConfig } from './config.js';
import { createYjsServer } from './server.js';

async function main(): Promise<void> {
    const config = loadConfig();
    const running = await createYjsServer(config);
    let shuttingDown = false;

    console.log(`Many Notes Yjs service listening on ${config.host}:${running.port}`);

    const shutdown = async (signal: string): Promise<void> => {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;
        console.log(`Received ${signal}, flushing Yjs state...`);

        try {
            await running.close();
            process.exit(0);
        } catch (error) {
            console.error('Could not shut down the Yjs service cleanly.', error);
            process.exit(1);
        }
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(error => {
    console.error('Could not start the Yjs service.', error);
    process.exit(1);
});
