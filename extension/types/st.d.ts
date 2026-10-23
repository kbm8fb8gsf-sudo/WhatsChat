/**
 * Minimal, hand-written declarations for the parts of SillyTavern this extension uses.
 * Only st-bridge.js may rely on these. Verified against SillyTavern 1.19.0.
 */

export {};

declare global {
    interface STChatMessage {
        name: string;
        is_user: boolean;
        is_system: boolean;
        mes: string;
        send_date?: string;
        extra?: Record<string, unknown>;
    }

    interface STCharacter {
        name: string;
        avatar: string;
        chat?: string;
    }

    interface STEventSource {
        on(event: string, listener: (...args: unknown[]) => unknown): void;
        removeListener(event: string, listener: (...args: unknown[]) => unknown): void;
    }

    interface STContext {
        chat: STChatMessage[];
        characters: STCharacter[];
        characterId: string | number | undefined;
        groupId: string | null | undefined;
        chatId: string | undefined;
        name1: string;
        name2: string;
        /** "no_connection" until SillyTavern has connected to the AI. */
        onlineStatus: string;
        /** Selected API type, e.g. "openai" for Chat Completion. */
        mainApi: string;
        eventSource: STEventSource;
        eventTypes: Record<string, string>;
        getRequestHeaders(): Record<string, string>;
        getCurrentChatId(): string | undefined;
        generate(type: string, options?: Record<string, unknown>): Promise<unknown>;
        setExtensionPrompt(
            key: string,
            value: string,
            position: number,
            depth: number,
            scan?: boolean,
            role?: number,
            filter?: (() => boolean | Promise<boolean>) | null,
        ): void;
        selectCharacterById(id: number, options?: { switchMenu?: boolean }): Promise<void>;
        openCharacterChat(fileName: string): Promise<void>;
        openGroupChat(groupId: string, chatId?: string): Promise<void>;
        saveChat(): Promise<void>;
        /** Re-read one character card from disk into `characters`. */
        getOneCharacter(avatar: string): Promise<void>;
        reloadCurrentChat(): Promise<void>;
        extensionSettings: Record<string, unknown>;
    }

    /** The `/script.js` module exports this extension imports directly (decision 2 in PLAN.md). */
    interface STScriptModule {
        sendMessageAsUser(text: string, bias?: string): Promise<STChatMessage>;
        doNewChat(options?: { deleteCurrentChat?: boolean }): Promise<void>;
        is_send_press: boolean;
        isChatSaving: boolean;
    }

    const SillyTavern: {
        getContext(): STContext;
    };
}
