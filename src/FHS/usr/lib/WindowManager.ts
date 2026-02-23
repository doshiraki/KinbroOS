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

import interact from 'interactjs';
import { DisplayServer } from './DisplayServer'; // Import!

// CSS import (assumed to be bundled during Userland build)
// Note: Ideally managed by a Theme Manager, but centralized here for now.
import cssXterm from '@xterm/xterm/css/xterm.css?inline';
import cssTerminal from '../include/terminal.css?inline';

export class WindowManager {
    private valX: number = 100;
    private valY: number = 100;
    private valW: number = 600;
    private valH: number = 400;

    private objDisplay: DisplayServer;

    constructor() {
        // Connect to DisplayServer (similar to `wl_display_connect` in Wayland)
        this.objDisplay = DisplayServer.getInstance();
        this.objDisplay.init(); // Initialize if necessary
    }

    public createWindow(strTitle: string): { domWindow: HTMLElement, domContent: HTMLElement, domCloseBtn: HTMLElement } {
        // 1. DOM Construction (Factory Logic)
        const domWindow = document.createElement('div');
        domWindow.className = 'kinbro-window';

        const domHeader = document.createElement('div');
        domHeader.className = 'window-header';

        const domTitle = document.createElement('div');
        domTitle.className = 'window-title';
        domTitle.textContent = strTitle;

        const domCloseBtn = document.createElement('button');
        domCloseBtn.className = 'window-close';
        domCloseBtn.textContent = '×';
        domCloseBtn.title = 'Close Session';

        domHeader.appendChild(domTitle);
        domHeader.appendChild(domCloseBtn);

        const domContent = document.createElement('div');
        domContent.className = 'terminal-container';

        domWindow.appendChild(domHeader);
        domWindow.appendChild(domContent);

        // 2. [Critical] Mount to DisplayServer root
        // WindowManager knows "where (Display)" to place it
        this.objDisplay.getRoot().appendChild(domWindow);

        // Prevent keyboard input leakage (e.g., prevents space key from triggering unintended actions)
        domWindow.addEventListener('keydown', (e) => e.stopPropagation());
        domWindow.addEventListener('keyup',   (e) => e.stopPropagation());
        
        // Prevent mouse interaction leakage (prevents unintended drags or focus shifts)
        domWindow.addEventListener('mousedown', (e) => e.stopPropagation());
        //domWindow.addEventListener('mouseup',   (e) => e.stopPropagation());
        domWindow.addEventListener('click',     (e) => e.stopPropagation());

        domCloseBtn.addEventListener('click', () => {
            if (confirm('Terminate ZenOS session?')) {
                domWindow.remove();
            }
        });
    
        // 3. Configuration of placement and behavior
        this.makeFloating(domWindow, () => {}); 

        return { domWindow, domContent, domCloseBtn };
    }

    /**
     * Converts specified element into a floating window.
     */
    public makeFloating(domTarget: HTMLElement, fnOnResize: () => void): void {
        // Offset initial coordinates (prevents overlapping when multiple windows open)
        this.valX += 20;
        this.valY += 20;

        Object.assign(domTarget.style, {
            position: 'fixed',
            left: '0px',
            top: '0px',
            transform: `translate(${this.valX}px, ${this.valY}px)`,
            width: `${this.valW}px`,
            height: `${this.valH}px`
        });

        // interact.js configuration (unchanged)
        interact(domTarget)
            .draggable({
                allowFrom: '.window-header',
                ignoreFrom: '.window-close',
                listeners: {
                    move: (objEvent) => {
                        // ※ 注意: この実装だと全ウィンドウで座標変数(this.valX)を共有しちゃうので、
                        // 本来はウィンドウ個別のstateを持つべきだけど、今回は簡易版として
                        // 現在のtransformから値を逆算して加算する方式などがベター。
                        // 一旦、個別のウィンドウインスタンスを持たないこのクラス設計なら
                        // data属性などに持たせるのが手っ取り早いかも。
                        
                        // [Fix] Manage coordinates via data attributes
                        const x = (parseFloat(domTarget.getAttribute('data-x') || String(this.valX))) + objEvent.dx;
                        const y = (parseFloat(domTarget.getAttribute('data-y') || String(this.valY))) + objEvent.dy;

                        domTarget.style.transform = `translate(${x}px, ${y}px)`;
                        domTarget.setAttribute('data-x', String(x));
                        domTarget.setAttribute('data-y', String(y));
                    }
                }
            })
            .resizable({
                edges: { left: false, right: true, bottom: true, top: false },
                listeners: {
                    move: (objEvent) => {
                        const { width, height } = objEvent.rect;
                        Object.assign(domTarget.style, {
                            width: `${width}px`,
                            height: `${height}px`
                        });
                        fnOnResize();
                    }
                },
                modifiers: [
                    interact.modifiers.restrictSize({ min: { width: 300, height: 200 } })
                ]
            });
            
        // Set initial values
        domTarget.setAttribute('data-x', String(this.valX));
        domTarget.setAttribute('data-y', String(this.valY));
    }
}
