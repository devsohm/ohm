import { Type } from "typebox";

import {
  EXTENSION_FACET_API_VERSION,
  EXTENSION_FACET_KINDS,
  MAX_EXTENSION_FACETS,
  MAX_EXTENSION_FACET_STATES,
  REPLICATED_JSON_STATE_PROTOCOL_VERSION,
  createExtensionWireServiceEndpoint,
  createReplicatedJsonState,
  describeExtensionWireServiceEndpoint,
  defineExtensionWireService,
  extensionFacetApplies,
  extensionFacetStateServiceName,
  extensionWireServiceRegistryName,
  extensionWireServiceRequest,
  validateExtensionFacetDefinition,
  validateExtensionWireServiceRequest,
  validateExtensionWireServiceResponse,
  type ExtensionFacetDefinition,
  type ExtensionFacetRegistration,
  type ExtensionFacetService,
  type ExtensionFacetSharedState,
  type ExtensionFacetStateHost,
  type ExtensionWireServiceDescriptor,
  type ExtensionWireServiceEndpoint,
  type ExtensionWireServiceRequest,
  type ExtensionWireServiceResponse,
  type ReplicatedJsonState,
  type ReplicatedJsonStateDelta,
} from "ohm/extensions";
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

const contract = defineExtensionWireService({
  name: "consumer.echo",
  version: 1,
  requestSchema: Type.Object({ text: Type.String() }),
  responseSchema: Type.Object({ text: Type.String() }),
});
const endpoint: ExtensionWireServiceEndpoint<{ text: string }, { text: string }> =
  createExtensionWireServiceEndpoint(contract, ({ text }) => ({ text }));
const wireRequest: ExtensionWireServiceRequest<{ text: string }> =
  extensionWireServiceRequest(contract, "consumer-1", { text: "hello" });
const wireResponse: Promise<ExtensionWireServiceResponse<{ text: string }>> = endpoint.request(wireRequest);
const registryName: string = extensionWireServiceRegistryName(contract);
const validatedRequest: ExtensionWireServiceRequest = validateExtensionWireServiceRequest(wireRequest);
const validatedResponse: ExtensionWireServiceResponse = validateExtensionWireServiceResponse({
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

const facetDefinition: ExtensionFacetDefinition = validateExtensionFacetDefinition({
  apiVersion: EXTENSION_FACET_API_VERSION,
  kind: "session",
  name: "consumer",
  setup(context) {
    context.createState({ ready: true });
    context.states.open("shared", { ready: true });
  },
});
declare const facets: ExtensionFacetService;
declare const facetStates: ExtensionFacetStateHost;
const facetRegistration: Promise<ExtensionFacetRegistration> = facets.register(facetDefinition);
const sharedState: ExtensionFacetSharedState<{ ready: boolean }> | undefined =
  facetStates.get<{ ready: boolean }>("shared");
const stateServiceName: string = extensionFacetStateServiceName("consumer.extension", "shared");
const descriptor: ExtensionWireServiceDescriptor =
  describeExtensionWireServiceEndpoint(endpoint, "consumer.extension");

void [
  EXTENSION_FACET_KINDS,
  MAX_EXTENSION_FACETS,
  MAX_EXTENSION_FACET_STATES,
  REPLICATED_JSON_STATE_PROTOCOL_VERSION,
  actionResult,
  delta,
  descriptor,
  extensionFacetApplies("rich-tui", "tui", { components: true }),
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
