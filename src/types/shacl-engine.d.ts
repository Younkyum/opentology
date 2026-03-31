declare module 'shacl-engine' {
  export class Validator {
    constructor(shapes: any, options: any);
    validate(options: any): Promise<any>;
  }
}
