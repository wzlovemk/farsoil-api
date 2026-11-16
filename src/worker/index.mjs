import runtimeConfig from "../../config/runtime.v1.json" with {type:"json"};

export {FarsoilBackend} from "./backend.mjs";

const backendName=runtimeConfig.runtimes.worker.durableObjectName;
if(typeof backendName!=="string"||!backendName.trim())
  throw new Error("Invalid Worker durableObjectName");

export default {
  async fetch(request,env){
    const id=env.BACKEND.idFromName(backendName);
    return env.BACKEND.get(id).fetch(request);
  }
};
