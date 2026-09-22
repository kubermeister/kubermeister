declare module '*.css' {}

interface Window {
    km: {
        invoke: (channel: string, input: unknown) => Promise<unknown>;
        subscribe: (channel: string, handler: (payload: unknown) => void) => () => void;
        importFile: (file: File) => Promise<unknown>;
        stream: (
            channel: string,
            input: unknown,
            onMessage: (message: unknown) => void,
        ) => { stop: () => void; send: (data: unknown) => void };
    };
}
