export const BUILTIN_PREDICATES_TURTLE = `\
@prefix otx: <https://opentology.dev/vocab#> .

<urn:predicate:Module.hasOpenIssue> a otx:Predicate ;
    otx:title "Module.hasOpenIssue" ;
    otx:sparqlTemplate """SELECT ?issue ?title WHERE { GRAPH <{{graphUri}}> { ?issue a otx:Issue ; otx:status "open" ; otx:title ?title ; otx:relatedTo <urn:module:{{module}}> . } }""" ;
    otx:requiredParam "module" .

<urn:predicate:Module.hasDependents> a otx:Predicate ;
    otx:title "Module.hasDependents" ;
    otx:sparqlTemplate """SELECT ?dep ?title WHERE { GRAPH <{{graphUri}}> { ?dep a otx:Module ; otx:dependsOn <urn:module:{{module}}> . OPTIONAL { ?dep otx:title ?title } } }""" ;
    otx:requiredParam "module" .

<urn:predicate:Decision.exists> a otx:Predicate ;
    otx:title "Decision.exists" ;
    otx:sparqlTemplate """ASK { GRAPH <{{graphUri}}> { ?d a otx:Decision ; otx:title ?t . FILTER(CONTAINS(LCASE(?t), LCASE("{{keyword}}"))) } }""" ;
    otx:requiredParam "keyword" .

<urn:predicate:Knowledge.exists> a otx:Predicate ;
    otx:title "Knowledge.exists" ;
    otx:sparqlTemplate """SELECT ?k ?title ?body WHERE { GRAPH <{{graphUri}}> { ?k a otx:Knowledge ; otx:title ?title . OPTIONAL { ?k otx:body ?body } FILTER(CONTAINS(LCASE(?title), LCASE("{{keyword}}"))) } } LIMIT 10""" ;
    otx:requiredParam "keyword" .

<urn:predicate:Issue.isResolved> a otx:Predicate ;
    otx:title "Issue.isResolved" ;
    otx:sparqlTemplate """ASK { GRAPH <{{graphUri}}> { <{{issue}}> a otx:Issue ; otx:status ?s . FILTER(?s = "resolved" || ?s = "closed") } }""" ;
    otx:requiredParam "issue" .

<urn:predicate:Module.hasSymbols> a otx:Predicate ;
    otx:title "Module.hasSymbols" ;
    otx:sparqlTemplate """SELECT ?sym ?type WHERE { GRAPH <{{graphUri}}> { ?sym otx:definedIn <urn:module:{{module}}> . ?sym a ?type . FILTER(?type IN (otx:Class, otx:Interface, otx:Function, otx:Method)) } }""" ;
    otx:requiredParam "module" .
`;
