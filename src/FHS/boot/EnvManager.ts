/*
 * Copyright 2026 @doshiraki
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { IEnvManager, EnvKey, EnvKeyType } from '../../dev/types/IEnvManager';

/**
 * [Class: EnvManager]
 * Class for managing environment variables.
 * System-global instances are persisted (localStorage),
 * while child process instances operate in-memory.
 */
export class EnvManager implements IEnvManager {
    private readonly strNamespace = 'ms_env_';
    private readonly mapCache: Map<string, string> = new Map(); // Relax Key type to string
    
    // Persistence flag (set to false for child processes)
    private readonly isPersistent: boolean;

    /**
     * @param initialData Initial data (for cloning)
     * @param isPersistent Whether to save to localStorage (Default: true)
     */
    constructor(initialData?: Record<string, string>, isPersistent: boolean = false) {
        this.isPersistent = window["localStorage"] && isPersistent;

        if (initialData) {
            // When creating clone: Set provided data
            for (const [key, val] of Object.entries(initialData)) {
                this.mapCache.set(key, val);
            }
        } else {
            // When creating new (System): Load default values
            this.initDefaults();
        }
    }

    /**
     * Get environment variable
     */
    public get(strKey: string): string {
        return this.mapCache.get(strKey) || '';
    }

    /**
     * Set environment variable
     */
    public set(strKey: string, strValue: string): void {
        this.mapCache.set(strKey, strValue);
        
        // Write to storage only in persistent mode
        if (this.isPersistent) {
            const strStorageKey = this.strNamespace + strKey;
            localStorage.setItem(strStorageKey, strValue);
        }
    }

    /**
     * Delete environment variable
     */
    public unset(strKey: string): void {
        this.mapCache.delete(strKey);
        
        if (this.isPersistent) {
            localStorage.removeItem(this.strNamespace + strKey);
        }
    }

    /**
     * Get full list (for export)
     */
    public listAll(): Record<string, string> {
        const objEnv: Record<string, string> = {};
        for (const [key, val] of this.mapCache.entries()) {
            objEnv[key] = val;
        }
        return objEnv;
    }

    /**
     * [New] Clone creation (for Child Process)
     * Returns a non-persistent (In-Memory) instance copying the current state.
     */
    public clone(): IEnvManager {
        // Create with isPersistent=false, passing a copy of self
        return new EnvManager(this.listAll());
    }

    /**
     * [Internal: Init]
     * Load default values at system boot
     */
    private initDefaults(): void {
        // Restore existing values from localStorage (Persistent mode only)
        if (this.isPersistent) {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith(this.strNamespace)) {
                    const envKey = key.slice(this.strNamespace.length);
                    const val = localStorage.getItem(key);
                    if (val) this.mapCache.set(envKey, val);
                }
            }
        }

        // Ensure essential variables exist (Set if missing)
        const ensure = (key: string, val: string) => {
            if (!this.mapCache.has(key)) {
                this.set(key, val);
            }
        };

        ensure(EnvKey.Path, '/usr/bin:/bin');
        ensure(EnvKey.User, 'geek');
        ensure(EnvKey.Home, '/home/geek');
        ensure(EnvKey.Term, 'xterm-256color');
        ensure(EnvKey.Prompt, 'geek@kinbro $ ');
        ensure(EnvKey.Lang, 'ja_JP.UTF-8');
    }
}
