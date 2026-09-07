import { Type } from "typebox";

import {
  PLUGIN_FACET_API_VERSION,
  PLUGIN_FACET_KINDS,
  MAX_PLUGIN_FACETS,
  MAX_PLUGIN_FACET_STATES,
  REPLICATED_JSON_STATE_PROTOCOL_VERSION,
  createPluginWireServiceEndpoint,
  createReplicatedJsonState,
  describePluginWireServiceEndpoint,
  definePluginWireService,
  pluginFacetApplies,
  pluginFacetStateServiceName,
  pluginWireServiceRegistryName,
  pluginWireServiceRequest,
  validatePluginFacetDefinition,
  validatePluginWireServiceRequest,
  validatePluginWireServiceResponse,
  type PluginFacetDefinition,
  type PluginFacetRegistration,
  type PluginFacetService,
  type PluginFacetSharedState,
  type PluginFacetStateHost,
  type PluginWireServiceDescriptor,
  type PluginWireServiceEndpoint,
  type PluginWireServiceRequest,
  type PluginWireServiceResponse,
  type ReplicatedJsonState,
  type ReplicatedJsonStateDelta,
} from "ohm/plugins";
import {
  PORTABLE_PRESENTATION_PROTOCOL_VERSION,
  createPortablePresentation,
  definePortablePresentationAction,
  portablePresentationRemoveEvent,
  portablePresentationShowEvent,
  projectPortablePresentationToLines,
  validatePortablePresentationActionRequest,
  type PortablePresentationActionRequest,
  type PortablePresentationActionResult,
  type PortablePresentationDocument,
  type PortablePresentationEvent,
} from "ohm/interfaces";
import { projectPortablePresentationToRuntimeUiBlock } from "ohm/tui";

const contract = definePluginWireService({
  name: "consumer.echo",
  version: 1,
  requestSchema: Type.Object({ text: Type.String() }),
  responseSchema: Type.Object({ text: Type.String() }),
});
const endpoint: PluginWireServiceEndpoint<{ text: string }, { text: string }> =
  createPluginWireServiceEndpoint(contract, ({ text }) => ({ text }));
const wireRequest: PluginWireServiceRequest<{ text: string }> =
  pluginWireServiceRequest(contract, "consumer-1", { text: "hello" });
const wireResponse: Promise<PluginWireServiceResponse<{ text: string }>> = endpoint.request(wireRequest);
const registryName: string = pluginWireServiceRegistryName(contract);
const validatedRequest: PluginWireServiceRequest = validatePluginWireServiceRequest(wireRequest);
const validatedResponse: PluginWireServiceResponse = validatePluginWireServiceResponse({
  protocolVersion: 1,
  service: contract.name,
  serviceVersion: contract.version,
  id: wireRequest.id,
  ok: true,
  payload: { text: "hello" },
}, wireRequest);

const state: ReplicatedJsonState<{ count: number }> = createReplicatedJsonState({ count: 0 });
const delta: ReplicatedJsonStateDelta = state.update([
  { type: "set", path: ["count"], value: 1 },
]);

const presentation = createPortablePresentation("consumer.extension", {
  id: "status",
  blocks: [{ type: "text", text: "Ready" }],
  actions: [definePortablePresentationAction({
    id: "acknowledge",
    label: "Acknowledge",
    inputSchema: Type.Object({ accepted: Type.Boolean() }),
    run: ({ accepted }) => ({ accepted }),
  })],
});
const document: PortablePresentationDocument = presentation.document;
const action: PortablePresentationActionRequest = validatePortablePresentationActionRequest({
  protocolVersion: PORTABLE_PRESENTATION_PROTOCOL_VERSION,
  owner: "consumer.extension",
  presentationId: "status",
  revision: 0,
  actionId: "acknowledge",
  input: { accepted: true },
});
const actionResult: Promise<PortablePresentationActionResult> = presentation.invoke(action);
const presentationEvents: PortablePresentationEvent[] = [
  portablePresentationShowEvent("consumer.extension", document),
  portablePresentationRemoveEvent("consumer.extension", document.id, document.revision),
];

const facetDefinition: PluginFacetDefinition = validatePluginFacetDefinition({
  apiVersion: PLUGIN_FACET_API_VERSION,
  kind: "session",
  name: "consumer",
  setup(context) {
    context.createState({ ready: true });
    context.states.open("shared", { ready: true });
  },
});
declare const facets: PluginFacetService;
declare const facetStates: PluginFacetStateHost;
const facetRegistration: Promise<PluginFacetRegistration> = facets.register(facetDefinition);
const sharedState: PluginFacetSharedState<{ ready: boolean }> | undefined =
  facetStates.get<{ ready: boolean }>("shared");
const stateServiceName: string = pluginFacetStateServiceName("consumer.extension", "shared");
const descriptor: PluginWireServiceDescriptor =
  describePluginWireServiceEndpoint(endpoint, "consumer.extension");

void [
  PLUGIN_FACET_KINDS,
  MAX_PLUGIN_FACETS,
  MAX_PLUGIN_FACET_STATES,
  REPLICATED_JSON_STATE_PROTOCOL_VERSION,
  actionResult,
  delta,
  descriptor,
  pluginFacetApplies("rich-tui", "tui", { components: true }),
  facetRegistration,
  sharedState,
  stateServiceName,
  presentationEvents,
  projectPortablePresentationToLines(document),
  projectPortablePresentationToRuntimeUiBlock(document),
  registryName,
  validatedRequest,
  validatedResponse,
  wireResponse,
];
