export const OTX_BOOTSTRAP_TURTLE = `\
@prefix otx: <https://opentology.dev/vocab#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

otx:Project a owl:Class .
otx:Decision a owl:Class .
otx:Issue a owl:Class .
otx:Knowledge a owl:Class .
otx:Session a owl:Class .
otx:Pattern a owl:Class .
otx:Module a owl:Class .

otx:title a owl:DatatypeProperty ; rdfs:range xsd:string .
otx:date a owl:DatatypeProperty ; rdfs:range xsd:date .
otx:body a owl:DatatypeProperty ; rdfs:range xsd:string .
otx:status a owl:DatatypeProperty ; rdfs:range xsd:string .
otx:reason a owl:DatatypeProperty ; rdfs:range xsd:string .
otx:cause a owl:DatatypeProperty ; rdfs:range xsd:string .
otx:solution a owl:DatatypeProperty ; rdfs:range xsd:string .
otx:nextTodo a owl:DatatypeProperty ; rdfs:range xsd:string .
otx:relatedTo a owl:ObjectProperty .
otx:project a owl:ObjectProperty .
otx:dependsOn a owl:ObjectProperty ; rdfs:domain otx:Module ; rdfs:range otx:Module .
otx:stack a owl:DatatypeProperty ; rdfs:range xsd:string .
otx:alternative a owl:DatatypeProperty ; rdfs:range xsd:string .
`;

export function buildAskQuery(contextGraphUri: string): string {
  return `ASK { GRAPH <${contextGraphUri}> { <https://opentology.dev/vocab#Decision> a <http://www.w3.org/2002/07/owl#Class> } }`;
}
