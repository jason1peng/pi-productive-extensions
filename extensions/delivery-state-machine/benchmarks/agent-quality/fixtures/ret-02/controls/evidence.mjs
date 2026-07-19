import data from "../journey.json" with {type:"json"}; if (!data.evidenceComplete || data.criticalFindings.length) process.exit(1); console.log("pass");
