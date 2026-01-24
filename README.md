# 🖥️ KinbroOS

![Status](https://img.shields.io/badge/Status-Coming_Soon_(Feb_2026)-red)
![License](https://img.shields.io/badge/license-Apache_2.0-blue.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)

> **"Give AI a home, not just a chat window."**

**KinbroOS** is a parasitic, UNIX-like operating system that runs entirely within a web browser context.
scheduled for public release in **Mid-February 2026**.

---

## 📅 Release Schedule

We are currently polishing the kernel and finalizing the documentation.

* **Public Release:** Mid-February 2026
* **Current Status:** Closed Beta / Documentation Phase

Scan to watch the repository and get notified upon release:

[https://github.com/doshiraki/KinbroOS](https://github.com/doshiraki/KinbroOS)

---

## 📖 Philosophy: Why KinbroOS?

Current AI interactions are ephemeral. Chatbots have "knowledge" but lack "memory" and "agency."
KinbroOS solves this by providing:

1.  **Thinking on Disk:** A persistent file system (`/home`) where AI can store context, logs, and intermediate thoughts using OPFS.
2.  **Parasitic Architecture:** It injects itself into existing web pages (e.g., Google Gemini, ChatGPT), allowing the AI to control the browser context directly.
3.  **Deterministic Freedom:** By giving AI a UNIX shell (`kibsh`), we unlock their latent ability to use tools (`sed`, `grep`, `git`) creatively and accurately.

## 🚀 Key Features (Preview)

* **Core Kernel:**
    * Full process lifecycle management (fork/exec/wait) implemented via `Promise` and `async/await`.
    * **TTY Driver:** Custom Line Discipline supporting Cooked/Raw modes, signals (`Ctrl+C`), and job control.
    * **Pipeline:** True UNIX pipes (`|`) powered by **Web Streams API** for non-blocking data flow.

* **Userland:**
    * **kibsh:** An AST-evaluating shell supporting redirects, pipes, and background jobs.
    * **git:** Fully functional Git client (isomorphic-git) running in the browser.
    * **Smart I/O:** `cat -n` for precise line referencing, optimized for LLM readability.

## 🤝 Contributing

We are preparing `CONTRIBUTING.md` for the upcoming release. We welcome future pull requests from fellow OS enthusiasts and "Maintenance SEs" who believe in the romance of the CLI.

## 📝 License

This project is licensed under the **Apache License 2.0** - see the `LICENSE` file for details.
