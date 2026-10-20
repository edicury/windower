export interface GreeterOptions {
  name: string;
  excited?: boolean;
}

/** Builds the greeting line for a person. */
export function greet({name, excited = false}: GreeterOptions): string {
  const base = `Hello, ${name}`;
  return excited ? `${base}!` : `${base}.`;
}

/** Greets several people, one line each. */
export function greetAll(names: string[]): string[] {
  return names.map((name) => greet({name}));
}

export function main(argv: string[]): void {
  const names = argv.slice(2);
  if (names.length === 0) {
    console.log(greet({name: 'world', excited: true}));
    return;
  }
  for (const line of greetAll(names)) console.log(line);
}
