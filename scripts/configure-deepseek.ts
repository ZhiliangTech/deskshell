import { deepSeekCredentialStatus, importDeepSeekCredentialFromClipboard } from "../packages/models/src/credentials.ts";

try {
  if (process.argv.includes("--from-clipboard")) {
    console.log(JSON.stringify(await importDeepSeekCredentialFromClipboard(), null, 2));
  } else if (process.argv.includes("--status")) {
    console.log(JSON.stringify(await deepSeekCredentialStatus(), null, 2));
  } else {
    console.log("Use --from-clipboard to import into Windows DPAPI, or --status to inspect configuration. Secret values are never displayed.");
  }
} catch {
  console.error("Credential configuration failed. Check that the clipboard contains only the API key and that the Windows user profile is available.");
  process.exitCode = 1;
}
