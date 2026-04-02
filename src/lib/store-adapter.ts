export interface SparqlResults {
  head: { vars: string[] };
  results: {
    bindings: Array<Record<string, { type: string; value: string; datatype?: string }>>;
  };
}

export interface SchemaRelations {
  subClassOf: Array<{ child: string; parent: string }>;
  domainRange: Array<{ property: string; domain?: string; range?: string }>;
}

export interface StoreAdapter {
  // Core SPARQL operations
  sparqlQuery(query: string): Promise<SparqlResults>;
  askQuery(query: string): Promise<boolean>;
  sparqlUpdate(update: string): Promise<void>;
  constructQuery(query: string): Promise<string>; // Returns Turtle string

  // Triple operations
  insertTurtle(graphUri: string, turtle: string): Promise<void>;
  dropGraph(graphUri: string): Promise<void>;
  deleteTriples(graphUri: string, options: { turtle?: string; where?: string }): Promise<void>;

  // Read operations
  getGraphTripleCount(graphUri: string): Promise<number>;
  exportGraph(graphUri: string): Promise<string>; // Returns Turtle
  diffGraph(
    graphUri: string,
    localTurtle: string,
  ): Promise<{ added: string[]; removed: string[]; unchanged: number }>;

  // Schema introspection
  getSchemaOverview(graphUri: string): Promise<{
    prefixes: Record<string, string>;
    classes: string[];
    properties: string[];
    tripleCount: number;
  }>;
  getClassDetails(
    graphUri: string,
    classUri: string,
  ): Promise<{
    classUri: string;
    instanceCount: number;
    properties: Array<{ property: string; count: number }>;
    sampleTriples: Array<{ s: string; p: string; o: string }>;
  }>;

  // Schema relationships for visualization
  getSchemaRelations(graphUri: string): Promise<SchemaRelations>;
}
