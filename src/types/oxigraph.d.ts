declare module 'oxigraph' {
  interface Term { termType: string; value: string; }
  interface NamedNodeTerm extends Term { termType: 'NamedNode'; }
  interface LiteralTerm extends Term { termType: 'Literal'; language: string; datatype: NamedNodeTerm; }
  interface BlankNodeTerm extends Term { termType: 'BlankNode'; }
  interface QuadTerm { subject: Term; predicate: Term; object: Term; graph: Term; }

  interface OxigraphStore {
    load(data: string, options: { format: string; base_iri?: string; to_graph_name?: any }): void;
    query(query: string): any;
    update(update: string): void;
    match(subject?: any, predicate?: any, object?: any, graph?: any): QuadTerm[];
    dump(options: { format: string; from_graph_name?: any }): string;
  }

  interface Oxigraph {
    Store: new () => OxigraphStore;
    namedNode(value: string): NamedNodeTerm;
    literal(value: string, languageOrDatatype?: string | NamedNodeTerm): LiteralTerm;
    blankNode(value?: string): BlankNodeTerm;
    defaultGraph(): Term;
    quad(subject: Term, predicate: Term, object: Term, graph?: Term): QuadTerm;
  }

  const oxigraph: Oxigraph;
  export default oxigraph;
}
