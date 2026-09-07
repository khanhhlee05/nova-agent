export class BrightspaceClient {
  constructor(private readonly origin: string) {}
  getOrigin(): string { return this.origin; }
}
