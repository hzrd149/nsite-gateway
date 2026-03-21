import debug from "debug";

if (!debug.enabled("nsite")) debug.enable("nsite,nsite:*");

const logger = debug("nsite");

export default logger;
