// If this leaks in from a VS Code/Cursor extension-host terminal, the OpenFin
// runtime (an Electron binary) starts as plain Node, rejects --startup-url,
// and exits instantly while the RVM still reports success. Strip it before
// anything spawns.
delete process.env.ELECTRON_RUN_AS_NODE;

import { connect, launch } from "@openfin/node-adapter";
import { setDefaultResultOrder } from "dns";

async function run(manifestUrl) {
  try {
    let quitRequested = false;
    let quit;

    const fin = await launchFromNode(manifestUrl);

    if (fin) {
      const manifest = await fin.System.fetchManifest(manifestUrl);

      if (manifest.platform?.uuid !== undefined) {
        quit = async () => {
          try {
            if (!quitRequested) {
              quitRequested = true;
              console.log("Calling platform quit");
              const platform = fin.Platform.wrapSync({ uuid: manifest.platform.uuid });
              await platform.quit();
            }
          } catch (err) {
            if (err.toString().includes("no longer connected")) {
              console.log("Platform no longer connected");
              console.log("Exiting process");
              process.exit();
            } else {
              console.error(err);
            }
          }
        };
        console.log(`Wrapped target platform: ${manifest.platform.uuid}`);
      } else {
        quit = async () => {
          try {
            if (!quitRequested) {
              quitRequested = true;
              console.log("Calling application quit");
              const app = fin.Application.wrapSync({ uuid: manifest.startup_app.uuid });
              await app.quit();
            }
          } catch (err) {
            console.error(err);
          }
        };
        console.log(`Wrapped classic app: ${manifest.startup_app.uuid}`);
      }

      process.on("exit", async () => {
        console.log("Process exit called");
        await quit();
      });

      process.on("SIGINT", async () => {
        console.log("Ctrl + C called");
        await quit();
      });

      console.log(`You successfully connected to the manifest: ${manifestUrl}`);
      console.log(`Please wait while the sample loads.`);
      console.log();
      console.log(`If using browser use the Quit option from the main menu.`);
      console.log(`Otherwise press Ctrl + C (Windows) or Command + C (Mac) to exit and close the sample.`);
      console.log();
    }
  } catch (e) {
    console.error(`Error: Connection failed`);
    console.error(e.message);
  }
}

async function launchFromNode(manifestUrl) {
  try {
    console.log(`Launching manifest...`);
    console.log();

    const port = await launch({ manifestUrl });

    const fin = await connect({
      uuid: `dev-connection-${Date.now()}`,
      address: `ws://127.0.0.1:${port}`,
      nonPersistent: true,
    });

    fin.once("disconnected", () => {
      console.log("Platform disconnected");
      console.log("Exiting process");
      process.exit();
    });

    return fin;
  } catch (e) {
    console.error("Error: Failed launching manifest");
    console.error(e.message);
    if (e.message.includes("Could not locate")) {
      console.error("Is the web server running and the manifest JSON valid?");
    }
  }
}

console.log("Launch Manifest");
console.log("===============");
console.log();
console.log(`Platform: ${process.platform}`);

const launchArgs = process.argv.slice(2);
const manifest = launchArgs.length > 0 ? launchArgs[0] : "http://localhost:5175/platform/manifest.fin.json";
console.log(`Manifest: ${manifest}`);

try {
  setDefaultResultOrder("ipv4first");
} catch {
  // Early versions of node do not support this method
}

run(manifest).catch((err) => console.error(err));
