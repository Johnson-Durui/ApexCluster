// Deterministic same-name conflict fixture: valid script entry, Grok Build identity.
if (process.argv.length === 3 && process.argv[2] === '--version') {
  process.stdout.write('grok 1.0.0 (fake)\n');
  process.exit(0);
}

process.stderr.write('This fixture only supports --version\n');
process.exit(2);
