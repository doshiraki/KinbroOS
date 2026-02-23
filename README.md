# 🚀 KinbroOS

![Status](https://img.shields.io/badge/Status-Active-brightgreen)
![Version](https://img.shields.io/badge/Version-1.0.0-blue)
![License](https://img.shields.io/badge/license-Apache_2.0-blue.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)

**AI-Native UNIX Environment running inside your Browser.**
![KinbroOS Demo](https://raw.githubusercontent.com/doshiraki/KinbroOS_demo/main/kinbro.webp)

> **"Give AI a home, not just a chat window."**

**KinbroOS** is a parasitic, UNIX-like operating system that runs entirely within a web browser context. 

---

## 💡 Philosophy: Why KinbroOS?

Current AI interactions are ephemeral. Chatbots have "knowledge" but lack "memory" and "agency."
KinbroOS solves this by providing:

1.  **Thinking on Disk:** A persistent file system (`/home`) where AI can store context, logs, and intermediate thoughts using OPFS.
2.  **Parasitic Architecture:** It injects itself into existing web pages (e.g., Google Gemini), allowing the AI to control the browser context directly.
3.  **Deterministic Freedom:** By giving AI a UNIX shell (`kibsh`), we unlock their latent ability to use tools (`sed`, `grep`, `git`) creatively and accurately.

## ✨ Key Features

* **Core Kernel:**
    * Full process lifecycle management (fork/exec/wait) implemented via `Promise` and `async/await`.
    * **TTY Driver:** Custom Line Discipline supporting Cooked/Raw modes, signals (`Ctrl+C`), and job control.
    * **Pipeline:** True UNIX pipes (`|`) powered by **Web Streams API** for non-blocking data flow.

* **Userland:**
    * **kibsh:** An AST-evaluating shell supporting redirects, pipes, and background jobs.
    * **git:** Fully functional Git client (isomorphic-git) running in the browser.
    * **Smart I/O:** `cat -n` for precise line referencing, optimized for LLM readability.

---

## 🛠️ Build & Installation

Follow these steps to build KinbroOS locally and inject it into your browser.

### 1. Transpilation and Build
Compile the source code to generate the kernel and userland executables. Run the following commands sequentially:

```bash
# Install dependencies
npm install

# Apply necessary patches
patch -p1 < patches/node_modules.patch 

# Standard build for userland tools
npm run build

# Specialized build for the kernel
npm run build -- --mode kernel
```

### 2. How to Boot (Bookmarklet)
KinbroOS operates by "parasitizing" any webpage via a browser bookmarklet.

1. Copy the contents of `src/bios/bookmarklet.js` from this repository.
2. Create a new bookmark in your browser, paste the copied code (starting with `javascript:`) into the URL field, and save it.
3. Open any webpage, then click the saved bookmarklet to execute it.
4. **First Boot:** You will be prompted to upload a file. Select the compiled kernel file (`vmKinbroOS.js`). The kernel will be saved to your browser's OPFS (Origin Private File System) and booted.

> **Note:** On subsequent boots, you will be given a prompt to either launch the existing kernel from OPFS or upload a new one to overwrite and update the system.

---

## 🧰 Useful Tools

We provide powerful tools to assist with development and debugging.

### OPFS Explorer (`opfsexplorer.js`)
A visual sidebar tool to explore and manage your browser's OPFS directory directly. Like the main OS, this is registered and launched as a bookmarklet.

* **Features:** Add files, download items, delete entries, and view real-time previews for images and text files.
* **Security:** Engineered to be strictly "Trusted Types Safe" with absolutely zero use of `innerHTML`, ensuring robust protection against DOM-based XSS.

---

## 🤝 Contributing

We welcome pull requests from fellow OS enthusiasts and developers who believe in the romance of the CLI. Please read `CONTRIBUTING.md` for details on our code of conduct, and the process for submitting pull requests to us.

## 📜 License

This project is licensed under the **Apache License 2.0** - see the `LICENSE` file for details.
