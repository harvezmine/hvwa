Misbehaving SSTI worker scripts for tests/ssti-worker.spec.ts (workerTransport({ workerUrl })): each stands in for
src/core/ssti/engine.ts and breaks one rule of its protocol (ready, then one result per render). render-once.ts is a
child process script: one render through the default worker, then the process must exit on its own.
