export {FarsoilBackend} from "./backend.mjs";

export default {
  async fetch(request,env){
    const id=env.BACKEND.idFromName("global");
    return env.BACKEND.get(id).fetch(request);
  }
};
