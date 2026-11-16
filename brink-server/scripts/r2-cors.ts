// Sets the R2 bucket's CORS policy so the upload page (served from
// PUBLIC_URL) can PUT file parts straight to the bucket and read each part's
// ETag. Run once after creating the bucket, and again if PUBLIC_URL changes.
//
// Needs only PUBLIC_URL and the four R2_* variables, so it runs on a laptop:
//   cd brink-server
//   PUBLIC_URL=https://brink.example.com R2_ACCOUNT_ID=... R2_BUCKET=... \
//   R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... node --import tsx scripts/r2-cors.ts
// or on the deployed machine, where they are already set:
//   fly ssh console -C "node --import tsx scripts/r2-cors.ts"
//
// The API token must be allowed to change bucket settings; an "Object Read &
// Write" token usually is not. If this fails with 403, paste the policy shown
// in docs/HOSTED.md into the bucket's CORS settings in the Cloudflare
// dashboard instead.

// storage.ts is written alongside this file in the same change.
// @ts-ignore -- resolved once src/storage.ts is present
import { storageFromConfig, setBucketCors, R2Storage } from "../src/storage.ts";

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`${name} is not set.`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const publicUrl = new URL(need("PUBLIC_URL")).origin;
  const storage = storageFromConfig({
    kind: "r2",
    accountId: need("R2_ACCOUNT_ID"),
    bucket: need("R2_BUCKET"),
    accessKeyId: need("R2_ACCESS_KEY_ID"),
    secretAccessKey: need("R2_SECRET_ACCESS_KEY"),
  });
  if (!(storage instanceof R2Storage)) throw new Error("expected an R2 store");
  const origins = [publicUrl];
  await setBucketCors(storage, origins);
  console.error(`CORS set on bucket ${process.env.R2_BUCKET}: uploads allowed from ${origins.join(", ")}.`);
}

main().catch((e) => {
  console.error("Could not set the bucket CORS policy:", e instanceof Error ? e.message : e);
  process.exit(1);
});
