Save a session summary to the OpenTology sessions graph.

Ask the user what was accomplished in this session, or summarize the conversation so far.

Then use push to insert a session record:

```turtle
@prefix otx: <https://opentology.dev/vocab#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<urn:session:{today's date}> a otx:Session ;
    otx:title "{session summary title}" ;
    otx:date "{YYYY-MM-DD}"^^xsd:date ;
    otx:body "{what was done}" ;
    otx:nextTodo "{what to do next}" .
```

Push to the sessions graph (use graph name "sessions").
