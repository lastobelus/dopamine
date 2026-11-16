# dopamine

Dopamine is a tiny tool that makes it convenient for agents to stand up ad hoc dashboards they can update, and which potentially outlive the thread.

- A small always-on hub serves dashboard pages that agent threads publish and update. A person reads them beside whichever agent thread they are working in.
- It is a transport and a thin GUI, not a framework. Agents write ordinary HTML and JavaScript pages, publish them once, and afterwards post only small data updates.
- Several threads can contribute to one dashboard, and a click on a dashboard can reach a thread, with each request handled at most once.
- Written in TypeScript and run directly by Node, with no runtime dependencies.
- An experiment, developed for the author's own multi-agent workflow. No support promise.
