// Prints an OWNER_PASSWORD_HASH for a password typed at the prompt (not
// echoed) or piped on stdin. The password never goes on the command line.
//
//   cd brink-server
//   node --import tsx scripts/hash-password.ts
import { hashPassword } from "../src/auth.ts";

const MIN_LENGTH = 12;

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("cancelled"));
        if (ch === "\u0004") return done();
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function readPiped(): Promise<string> {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data.split(/\r?\n/)[0];
}

async function main() {
  let password: string;
  if (process.stdin.isTTY) {
    password = await readHidden("Owner password: ");
    const again = await readHidden("Same password again: ");
    if (password !== again) {
      console.error("The two passwords are different. Nothing was printed; run it again.");
      process.exit(1);
    }
  } else {
    password = await readPiped();
  }
  if (password.length < MIN_LENGTH) {
    console.error(`Use at least ${MIN_LENGTH} characters (a few unrelated words works well). Nothing was printed.`);
    process.exit(1);
  }
  const hash = await hashPassword(password);
  console.error("Set this as the OWNER_PASSWORD_HASH secret (it is a hash, not the password):");
  process.stdout.write(`${hash}\n`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
