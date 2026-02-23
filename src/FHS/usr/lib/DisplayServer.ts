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

// src/FHS/usr/lib/DisplayServer.ts
import cssFrame from '../include/window-frame.css?inline'; // ✨ New!

/**
 * [Class: DisplayServer] (Role: Wayland Output)
 * Manages the physical rendering area (Shadow DOM Host).
 * Provides the "root" element where applications and WindowManager render.
 */
export class DisplayServer {
    
    // Entity of the rendering area
    private domHost: HTMLElement | null = null;
    private shadowRoot: ShadowRoot | null = null;
    
    private readonly ID_HOST = 'kinbro-desktop';

    private constructor() {
        // Private Constructor (Singleton Pattern)
    }

    /**
     * Get instance (Lazy Initialization)
     */
    public static getInstance(): DisplayServer {
        let instance: any;
        const win = window as any;
        for (let i = 0; i < 2; i++) {
            instance = win.KinbroDisplayServer;
            if (instance) {
                break;
            }
            win.KinbroDisplayServer = new DisplayServer();
        }
        return instance;    
    }

    /**
     * [Boot] Initialize display environment
     * Create Shadow DOM and inject base styles (CSS)
     */
    public init(): void {
        if (this.shadowRoot) return; // Already initialized

        // 1. Acquire Host Element (Monitor Frame)
        let host = document.getElementById(this.ID_HOST);
        if (!host) {
            host = document.createElement('div');
            host.id = this.ID_HOST;
            
            // Setup to cover full screen (Pointer Events are transparent)
            Object.assign(host.style, { 
                position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh', 
                zIndex: '2147483647', pointerEvents: 'none' 
            });
            document.body.appendChild(host);
        }
        this.domHost = host;

        // 2. Create Shadow Root (Rendering Context)
        this.shadowRoot = host.attachShadow({ mode: 'open' });

        // 3. Inject Global Styles (Compositor Level Styles)
        // Inject OS-wide common themes here
        const style = document.createElement('style');
        style.textContent = `
            :host { all: initial; font-family: sans-serif; pointer-events: none; }
            .kinbro-window { pointer-events: auto; } /* Only windows are interactable */
            
            /* Manage application-wide CSS here */
            ${cssFrame}
        `;
        this.shadowRoot.appendChild(style);
        
        console.log('🖥️ [DisplayServer] Output initialized.');
    }

    /**
     * Get the root element for mounting windows
     */
    public getRoot(): ShadowRoot {
        if (!this.shadowRoot) {
            throw new Error('DisplayServer panic: Output not initialized.');
        }
        return this.shadowRoot;
    }

    /**
     * Shutdown (for debugging and emergency stops)
     */
    public shutdown(): void {
        if (this.domHost) {
            this.domHost.remove();
            this.domHost = null;
            this.shadowRoot = null;
        }
    }
}
