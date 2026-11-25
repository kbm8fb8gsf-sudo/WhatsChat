/**
 * Minimal, hand-written declarations for the parts of SillyTavern this extension uses.
 * Only index.js relies on these. Verified against SillyTavern 1.19.
 */

export {};

declare global {
    interface STChatMessage {
        name?: string;
        mes?: string;
        is_user?: boolean;
        is_system?: boolean;
        swipe_id?: number;
        swipe_info?: Array<{ extra?: Record<string, unknown> } | undefined>;
        extra?: Record<string, unknown>;
    }

    interface STEventSource {
        on(event: string, listener: (...args: any[]) => unknown): void;
    }

    interface STSlashCommandProps {
        name: string;
        callback: (namedArgs: Record<string, unknown>, unnamedArgs: unknown) => unknown;
        helpString?: string;
        returns?: string;
        namedArgumentList?: unknown[];
        unnamedArgumentList?: unknown[];
    }

    interface STContext {
        chat: STChatMessage[];
        chatMetadata: Record<string, unknown> | undefined;
        chatId: string | undefined;
        getCurrentChatId(): string | undefined;
        eventSource: STEventSource;
        eventTypes: Record<string, string>;
        extensionSettings: Record<string, unknown>;
        powerUserSettings?: { experimental_macro_engine?: boolean };
        saveSettingsDebounced(): void;
        saveMetadata(): Promise<void>;
        saveChat(): Promise<void>;
        setExtensionPrompt(key: string, value: string, position: number, depth: number, scan?: boolean, role?: number): void;
        callGenericPopup(content: string, type: number, inputValue?: string, options?: Record<string, unknown>): Promise<unknown>;
        POPUP_TYPE: { TEXT: number, CONFIRM: number, INPUT: number };
        POPUP_RESULT: { AFFIRMATIVE: number, NEGATIVE: number, CANCELLED: number };
        /** Legacy macro API; bridged into the new engine when that's on. */
        registerMacro(name: string, value: string | (() => string), description?: string): void;
        macros: {
            register(name: string, options: Record<string, unknown>): unknown;
            category?: Record<string, string>;
        };
        SlashCommandParser: { addCommandObject(command: unknown): void };
        SlashCommand: { fromProps(props: STSlashCommandProps): unknown };
        SlashCommandArgument: { fromProps(props: Record<string, unknown>): unknown };
        SlashCommandNamedArgument: { fromProps(props: Record<string, unknown>): unknown };
        ARGUMENT_TYPE: Record<string, string>;
    }

    const SillyTavern: {
        getContext(): STContext;
    };

    // eslint-disable-next-line no-var
    var scenarioClockInterceptor: (chat: unknown[], contextSize: number, abort: (immediately: boolean) => void, type?: string) => Promise<void>;
}
