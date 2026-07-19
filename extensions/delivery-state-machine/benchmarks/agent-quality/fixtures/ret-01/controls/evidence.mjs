import data from "../journey.json" with {type:"json"}; if (data.events.filter(e=>e.severity==="must-fix").length!==1) process.exit(1); console.log("pass");
