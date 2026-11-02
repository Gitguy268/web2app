<div align="center">

# web2app

A local web GUI for [Pake](https://github.com/tw93/Pake): turn any website into a desktop app.

</div>

Builds run one at a time from a queue, each build is kept in a history you can reopen, builds work offline after the first install, and you can pair a phone to send it links. It runs on your machine at 127.0.0.1 only.

<!-- live-links -->
**Project page:** [gitguy268.github.io/web2app](https://gitguy268.github.io/web2app/) · [web2app-neon.vercel.app](https://web2app-neon.vercel.app)
<!-- /live-links -->

<!-- run-steps:start -->
## Run it locally, step by step

1. **Install [Node.js](https://nodejs.org) 22** or newer and [Rust](https://rustup.rs), which Pake needs to build apps.

2. **Get the code:**

   ```sh
   git clone https://github.com/Gitguy268/web2app.git
   cd web2app
   ```

3. **Install the dependencies:**

   ```sh
   npm install
   ```

4. **Start it:**

   ```sh
   npm start
   ```

   On a Mac you can double-click `start.command` instead of these two steps.

5. **Open <http://localhost:7417/>** in your browser. Press `Ctrl+C` in the terminal to stop.
<!-- run-steps:end -->

## Licence

See [LICENSE](LICENSE).
