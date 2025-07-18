/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/prefer-optional-chain */
/* eslint-disable @typescript-eslint/no-shadow */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable id-denylist */
/* eslint-disable prefer-spread */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/restrict-template-expressions */
import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import type { Project } from '@n8n/db';
import { Container } from '@n8n/di';
import type express from 'express';
import get from 'lodash/get';
import { BinaryDataService, ErrorReporter } from 'n8n-core';
import type {
	IBinaryData,
	IBinaryKeyData,
	IDataObject,
	IDeferredPromise,
	IExecuteData,
	IN8nHttpFullResponse,
	INode,
	IPinData,
	IRunExecutionData,
	IWebhookData,
	IWebhookResponseData,
	IWorkflowDataProxyAdditionalKeys,
	IWorkflowExecuteAdditionalData,
	WebhookResponseMode,
	Workflow,
	WorkflowExecuteMode,
	IWorkflowExecutionDataProcess,
	IWorkflowBase,
	WebhookResponseData,
} from 'n8n-workflow';
import {
	BINARY_ENCODING,
	createDeferredPromise,
	ExecutionCancelledError,
	FORM_NODE_TYPE,
	FORM_TRIGGER_NODE_TYPE,
	NodeOperationError,
	OperationalError,
	UnexpectedError,
	WAIT_NODE_TYPE,
} from 'n8n-workflow';
import { finished } from 'stream/promises';

import { ActiveExecutions } from '@/active-executions';
import { MCP_TRIGGER_NODE_TYPE } from '@/constants';
import { InternalServerError } from '@/errors/response-errors/internal-server.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { UnprocessableRequestError } from '@/errors/response-errors/unprocessable.error';
import { parseBody } from '@/middlewares';
import { OwnershipService } from '@/services/ownership.service';
import { WorkflowStatisticsService } from '@/services/workflow-statistics.service';
import { WaitTracker } from '@/wait-tracker';
import { createMultiFormDataParser } from '@/webhooks/webhook-form-data';
import * as WorkflowExecuteAdditionalData from '@/workflow-execute-additional-data';
import * as WorkflowHelpers from '@/workflow-helpers';
import { WorkflowRunner } from '@/workflow-runner';

import { WebhookService } from './webhook.service';
import type { IWebhookResponseCallbackData, WebhookRequest } from './webhook.types';

/**
 * Returns all the webhooks which should be created for the given workflow
 */
export function getWorkflowWebhooks(
	workflow: Workflow,
	additionalData: IWorkflowExecuteAdditionalData,
	destinationNode?: string,
	ignoreRestartWebhooks = false,
): IWebhookData[] {
	// Check all the nodes in the workflow if they have webhooks

	const returnData: IWebhookData[] = [];

	let parentNodes: string[] | undefined;
	if (destinationNode !== undefined) {
		parentNodes = workflow.getParentNodes(destinationNode);
		// Also add the destination node in case it itself is a webhook node
		parentNodes.push(destinationNode);
	}

	for (const node of Object.values(workflow.nodes)) {
		if (parentNodes !== undefined && !parentNodes.includes(node.name)) {
			// If parentNodes are given check only them if they have webhooks
			// and no other ones

			continue;
		}
		returnData.push.apply(
			returnData,
			Container.get(WebhookService).getNodeWebhooks(
				workflow,
				node,
				additionalData,
				ignoreRestartWebhooks,
			),
		);
	}

	return returnData;
}

// eslint-disable-next-line complexity
export function autoDetectResponseMode(
	workflowStartNode: INode,
	workflow: Workflow,
	method: string,
): WebhookResponseMode | undefined {
	if (workflowStartNode.type === FORM_TRIGGER_NODE_TYPE && method === 'POST') {
		const connectedNodes = workflow.getChildNodes(workflowStartNode.name);

		for (const nodeName of connectedNodes) {
			const node = workflow.nodes[nodeName];

			if (node.type === WAIT_NODE_TYPE && node.parameters.resume !== 'form') {
				continue;
			}

			if ([FORM_NODE_TYPE, WAIT_NODE_TYPE].includes(node.type) && !node.disabled) {
				return 'formPage';
			}
		}
	}

	// If there are form nodes connected to a current form node we're dealing with a multipage form
	// and we need to return the formPage response mode when a second page of the form gets submitted
	// to be able to show potential form errors correctly.
	if (workflowStartNode.type === FORM_NODE_TYPE && method === 'POST') {
		const connectedNodes = workflow.getChildNodes(workflowStartNode.name);

		for (const nodeName of connectedNodes) {
			const node = workflow.nodes[nodeName];

			if (node.type === FORM_NODE_TYPE && !node.disabled) {
				return 'formPage';
			}
		}
	}

	if (workflowStartNode.type === WAIT_NODE_TYPE && workflowStartNode.parameters.resume !== 'form') {
		return undefined;
	}

	if (
		workflowStartNode.type === FORM_NODE_TYPE &&
		workflowStartNode.parameters.operation === 'completion'
	) {
		return 'onReceived';
	}
	if ([FORM_NODE_TYPE, WAIT_NODE_TYPE].includes(workflowStartNode.type) && method === 'POST') {
		const connectedNodes = workflow.getChildNodes(workflowStartNode.name);

		for (const nodeName of connectedNodes) {
			const node = workflow.nodes[nodeName];

			if (node.type === WAIT_NODE_TYPE && node.parameters.resume !== 'form') {
				continue;
			}

			if ([FORM_NODE_TYPE, WAIT_NODE_TYPE].includes(node.type) && !node.disabled) {
				return 'responseNode';
			}
		}
	}

	return undefined;
}

/**
 * for formTrigger and form nodes redirection has to be handled by sending redirectURL in response body
 */
export const handleFormRedirectionCase = (
	data: IWebhookResponseCallbackData,
	workflowStartNode: INode,
) => {
	if (workflowStartNode.type === WAIT_NODE_TYPE && workflowStartNode.parameters.resume !== 'form') {
		return data;
	}

	if (
		[FORM_NODE_TYPE, FORM_TRIGGER_NODE_TYPE, WAIT_NODE_TYPE].includes(workflowStartNode.type) &&
		(data?.headers as IDataObject)?.location &&
		String(data?.responseCode).startsWith('3')
	) {
		data.responseCode = 200;
		data.data = {
			redirectURL: (data?.headers as IDataObject)?.location,
		};
		(data.headers as IDataObject).location = undefined;
	}

	return data;
};

const { formDataFileSizeMax } = Container.get(GlobalConfig).endpoints;
const parseFormData = createMultiFormDataParser(formDataFileSizeMax);

/** Return webhook response when responseMode is set to "onReceived" */
export function getResponseOnReceived(
	responseData: WebhookResponseData | string | undefined,
	webhookResultData: IWebhookResponseData,
	responseCode: number,
): IWebhookResponseCallbackData {
	const callbackData: IWebhookResponseCallbackData = { responseCode };
	// Return response directly and do not wait for the workflow to finish
	if (responseData === 'noData') {
		// Return without data
	} else if (responseData) {
		// Return the data specified in the response data option
		callbackData.data = responseData as unknown as IDataObject;
	} else if (webhookResultData.webhookResponse !== undefined) {
		// Data to respond with is given
		callbackData.data = webhookResultData.webhookResponse;
	} else {
		callbackData.data = { message: 'Workflow was started' };
	}
	return callbackData;
}

export function setupResponseNodePromise(
	responsePromise: IDeferredPromise<IN8nHttpFullResponse>,
	res: express.Response,
	responseCallback: (error: Error | null, data: IWebhookResponseCallbackData) => void,
	workflowStartNode: INode,
	executionId: string | undefined,
	workflow: Workflow,
): void {
	void responsePromise.promise
		.then(async (response: IN8nHttpFullResponse) => {
			const binaryData = (response.body as IDataObject)?.binaryData as IBinaryData;
			if (binaryData?.id) {
				res.header(response.headers);
				const stream = await Container.get(BinaryDataService).getAsStream(binaryData.id);
				stream.pipe(res, { end: false });
				await finished(stream);
				responseCallback(null, { noWebhookResponse: true });
			} else if (Buffer.isBuffer(response.body)) {
				res.header(response.headers);
				res.end(response.body);
				responseCallback(null, { noWebhookResponse: true });
			} else {
				// TODO: This probably needs some more changes depending on the options on the
				//       Webhook Response node

				let data: IWebhookResponseCallbackData = {
					data: response.body as IDataObject,
					headers: response.headers,
					responseCode: response.statusCode,
				};

				data = handleFormRedirectionCase(data, workflowStartNode);

				responseCallback(null, data);
			}

			process.nextTick(() => res.end());
		})
		.catch(async (error) => {
			Container.get(ErrorReporter).error(error);
			Container.get(Logger).error(
				`Error with Webhook-Response for execution "${executionId}": "${error.message}"`,
				{ executionId, workflowId: workflow.id },
			);
			responseCallback(error, {});
		});
}

export function prepareExecutionData(
	executionMode: WorkflowExecuteMode,
	workflowStartNode: INode,
	webhookResultData: IWebhookResponseData,
	runExecutionData: IRunExecutionData | undefined,
	runExecutionDataMerge: object = {},
	destinationNode?: string,
	executionId?: string,
	workflowData?: IWorkflowBase,
): { runExecutionData: IRunExecutionData; pinData: IPinData | undefined } {
	// Initialize the data of the webhook node
	const nodeExecutionStack: IExecuteData[] = [
		{
			node: workflowStartNode,
			data: {
				main: webhookResultData.workflowData ?? [],
			},
			source: null,
		},
	];

	runExecutionData ??= {
		startData: {},
		resultData: {
			runData: {},
		},
		executionData: {
			contextData: {},
			nodeExecutionStack,
			waitingExecution: {},
		},
	} as IRunExecutionData;

	if (destinationNode && runExecutionData.startData) {
		runExecutionData.startData.destinationNode = destinationNode;
	}

	if (executionId !== undefined) {
		// Set the data the webhook node did return on the waiting node if executionId
		// already exists as it means that we are restarting an existing execution.
		runExecutionData.executionData!.nodeExecutionStack[0].data.main =
			webhookResultData.workflowData ?? [];
	}

	if (Object.keys(runExecutionDataMerge).length !== 0) {
		// If data to merge got defined add it to the execution data
		Object.assign(runExecutionData, runExecutionDataMerge);
	}

	let pinData: IPinData | undefined;
	const usePinData = ['manual', 'evaluation'].includes(executionMode);
	if (usePinData) {
		pinData = workflowData?.pinData;
		runExecutionData.resultData.pinData = pinData;
	}

	return { runExecutionData, pinData };
}

/**
 * Executes a webhook
 */
// eslint-disable-next-line complexity
export async function executeWebhook(
	workflow: Workflow,
	webhookData: IWebhookData,
	workflowData: IWorkflowBase,
	workflowStartNode: INode,
	executionMode: WorkflowExecuteMode,
	pushRef: string | undefined,
	runExecutionData: IRunExecutionData | undefined,
	executionId: string | undefined,
	req: WebhookRequest,
	res: express.Response,
	responseCallback: (error: Error | null, data: IWebhookResponseCallbackData) => void,
	destinationNode?: string,
): Promise<string | undefined> {
	// Get the nodeType to know which responseMode is set
	const nodeType = workflow.nodeTypes.getByNameAndVersion(
		workflowStartNode.type,
		workflowStartNode.typeVersion,
	);

	const additionalKeys: IWorkflowDataProxyAdditionalKeys = {
		$executionId: executionId,
	};

	let project: Project | undefined = undefined;
	try {
		project = await Container.get(OwnershipService).getWorkflowProjectCached(workflowData.id);
	} catch (error) {
		throw new NotFoundError('Cannot find workflow');
	}

	// Prepare everything that is needed to run the workflow
	const additionalData = await WorkflowExecuteAdditionalData.getBase();

	if (executionId) {
		additionalData.executionId = executionId;
	}

	//check if response mode should be set automatically, e.g. multipage form
	const responseMode =
		autoDetectResponseMode(workflowStartNode, workflow, req.method) ??
		(workflow.expression.getSimpleParameterValue(
			workflowStartNode,
			webhookData.webhookDescription.responseMode,
			executionMode,
			additionalKeys,
			undefined,
			'onReceived',
		) as WebhookResponseMode);

	const responseCode = workflow.expression.getSimpleParameterValue(
		workflowStartNode,
		webhookData.webhookDescription.responseCode as string,
		executionMode,
		additionalKeys,
		undefined,
		200,
	) as number;

	// This parameter is used for two different purposes:
	// 1. as arbitrary string input defined in the workflow in the "respond immediately" mode,
	// 2. as well as WebhookResponseData config in all the other modes
	const responseData = workflow.expression.getComplexParameterValue(
		workflowStartNode,
		webhookData.webhookDescription.responseData,
		executionMode,
		additionalKeys,
		undefined,
		'firstEntryJson',
	) as WebhookResponseData | string | undefined;

	if (!['onReceived', 'lastNode', 'responseNode', 'formPage', 'streaming'].includes(responseMode)) {
		// If the mode is not known we error. Is probably best like that instead of using
		// the default that people know as early as possible (probably already testing phase)
		// that something does not resolve properly.
		const errorMessage = `The response mode '${responseMode}' is not valid!`;
		responseCallback(new UnexpectedError(errorMessage), {});
		throw new InternalServerError(errorMessage);
	}

	// Add the Response and Request so that this data can be accessed in the node
	additionalData.httpRequest = req;
	additionalData.httpResponse = res;

	let binaryData;

	const nodeVersion = workflowStartNode.typeVersion;
	if (nodeVersion === 1) {
		// binaryData option is removed in versions higher than 1
		binaryData = workflow.expression.getSimpleParameterValue(
			workflowStartNode,
			'={{$parameter["options"]["binaryData"]}}',
			executionMode,
			additionalKeys,
			undefined,
			false,
		);
	}

	let didSendResponse = false;
	let runExecutionDataMerge = {};
	try {
		// Run the webhook function to see what should be returned and if
		// the workflow should be executed or not
		let webhookResultData: IWebhookResponseData;

		// if `Webhook` or `Wait` node, and binaryData is enabled, skip pre-parse the request-body
		// always falsy for versions higher than 1
		if (!binaryData) {
			const { contentType } = req;
			if (contentType === 'multipart/form-data') {
				req.body = await parseFormData(req);
			} else {
				if (nodeVersion > 1) {
					if (
						contentType?.startsWith('application/json') ||
						contentType?.startsWith('text/plain') ||
						contentType?.startsWith('application/x-www-form-urlencoded') ||
						contentType?.endsWith('/xml') ||
						contentType?.endsWith('+xml')
					) {
						await parseBody(req);
					}
				} else {
					await parseBody(req);
				}
			}
		}

		// TODO: remove this hack, and make sure that execution data is properly created before the MCP trigger is executed
		if (workflowStartNode.type === MCP_TRIGGER_NODE_TYPE) {
			// Initialize the data of the webhook node
			const nodeExecutionStack: IExecuteData[] = [];
			nodeExecutionStack.push({
				node: workflowStartNode,
				data: {
					main: [],
				},
				source: null,
			});
			runExecutionData =
				runExecutionData ||
				({
					startData: {},
					resultData: {
						runData: {},
					},
					executionData: {
						contextData: {},
						nodeExecutionStack,
						waitingExecution: {},
					},
				} as IRunExecutionData);
		}

		try {
			webhookResultData = await Container.get(WebhookService).runWebhook(
				workflow,
				webhookData,
				workflowStartNode,
				additionalData,
				executionMode,
				runExecutionData ?? null,
			);
			Container.get(WorkflowStatisticsService).emit('nodeFetchedData', {
				workflowId: workflow.id,
				node: workflowStartNode,
			});
		} catch (err) {
			// Send error response to webhook caller
			const webhookType = ['formTrigger', 'form'].includes(nodeType.description.name)
				? 'Form'
				: 'Webhook';
			let errorMessage = `Workflow ${webhookType} Error: Workflow could not be started!`;

			// if workflow started manually, show an actual error message
			if (err instanceof NodeOperationError && err.type === 'manual-form-test') {
				errorMessage = err.message;
			}

			Container.get(ErrorReporter).error(err, {
				extra: {
					nodeName: workflowStartNode.name,
					nodeType: workflowStartNode.type,
					nodeVersion: workflowStartNode.typeVersion,
					workflowId: workflow.id,
				},
			});

			responseCallback(new UnexpectedError(errorMessage), {});
			didSendResponse = true;

			// Add error to execution data that it can be logged and send to Editor-UI
			runExecutionDataMerge = {
				resultData: {
					runData: {},
					lastNodeExecuted: workflowStartNode.name,
					error: {
						...err,
						message: err.message,
						stack: err.stack,
					},
				},
			};

			webhookResultData = {
				noWebhookResponse: true,
				// Add empty data that it at least tries to "execute" the webhook
				// which then so gets the chance to throw the error.
				workflowData: [[{ json: {} }]],
			};
		}

		if (webhookData.webhookDescription.responseHeaders !== undefined) {
			const responseHeaders = workflow.expression.getComplexParameterValue(
				workflowStartNode,
				webhookData.webhookDescription.responseHeaders,
				executionMode,
				additionalKeys,
				undefined,
				undefined,
			) as {
				entries?:
					| Array<{
							name: string;
							value: string;
					  }>
					| undefined;
			};

			if (!res.headersSent) {
				// Only set given headers if they haven't been sent yet, e.g. for streaming
				if (responseHeaders !== undefined && responseHeaders.entries !== undefined) {
					for (const item of responseHeaders.entries) {
						res.setHeader(item.name, item.value);
					}
				}
			}
		}

		if (webhookResultData.noWebhookResponse === true && !didSendResponse) {
			// The response got already send
			responseCallback(null, {
				noWebhookResponse: true,
			});
			didSendResponse = true;
		}

		if (webhookResultData.workflowData === undefined) {
			// Workflow should not run
			if (webhookResultData.webhookResponse !== undefined) {
				// Data to respond with is given
				if (!didSendResponse) {
					responseCallback(null, {
						data: webhookResultData.webhookResponse,
						responseCode,
					});
					didSendResponse = true;
				}
			} else {
				// Send default response

				if (!didSendResponse) {
					responseCallback(null, {
						data: {
							message: 'Webhook call received',
						},
						responseCode,
					});
					didSendResponse = true;
				}
			}
			return;
		}

		// Now that we know that the workflow should run we can return the default response
		// directly if responseMode it set to "onReceived" and a response should be sent
		if (responseMode === 'onReceived' && !didSendResponse) {
			const callbackData = getResponseOnReceived(responseData, webhookResultData, responseCode);
			responseCallback(null, callbackData);
			didSendResponse = true;
		}

		// Prepare execution data
		const { runExecutionData: preparedRunExecutionData, pinData } = prepareExecutionData(
			executionMode,
			workflowStartNode,
			webhookResultData,
			runExecutionData,
			runExecutionDataMerge,
			destinationNode,
			executionId,
			workflowData,
		);
		runExecutionData = preparedRunExecutionData;

		const runData: IWorkflowExecutionDataProcess = {
			executionMode,
			executionData: runExecutionData,
			pushRef,
			workflowData,
			pinData,
			projectId: project?.id,
		};

		// When resuming from a wait node, copy over the pushRef from the execution-data
		if (!runData.pushRef) {
			runData.pushRef = runExecutionData.pushRef;
		}

		let responsePromise: IDeferredPromise<IN8nHttpFullResponse> | undefined;
		if (responseMode === 'responseNode') {
			responsePromise = createDeferredPromise<IN8nHttpFullResponse>();
			setupResponseNodePromise(
				responsePromise,
				res,
				responseCallback,
				workflowStartNode,
				executionId,
				workflow,
			);
		}

		if (responseMode === 'streaming') {
			Container.get(Logger).debug(
				`Execution of workflow "${workflow.name}" from with ID ${executionId} is set to streaming`,
				{ executionId },
			);
			// TODO: Add check for streaming nodes here
			runData.httpResponse = res;
			runData.streamingEnabled = true;
			didSendResponse = true;
		}

		// Start now to run the workflow
		executionId = await Container.get(WorkflowRunner).run(
			runData,
			true,
			!didSendResponse,
			executionId,
			responsePromise,
		);

		if (responseMode === 'formPage' && !didSendResponse) {
			res.send({ formWaitingUrl: `${additionalData.formWaitingBaseUrl}/${executionId}` });
			process.nextTick(() => res.end());
			didSendResponse = true;
		}

		Container.get(Logger).debug(
			`Started execution of workflow "${workflow.name}" from webhook with execution ID ${executionId}`,
			{ executionId },
		);

		const activeExecutions = Container.get(ActiveExecutions);

		// Get a promise which resolves when the workflow did execute and send then response
		const executePromise = activeExecutions.getPostExecutePromise(executionId);

		const { parentExecution } = runExecutionData;
		if (parentExecution) {
			// on child execution completion, resume parent execution
			void executePromise.then(() => {
				const waitTracker = Container.get(WaitTracker);
				void waitTracker.startExecution(parentExecution.executionId);
			});
		}

		if (!didSendResponse) {
			executePromise
				// eslint-disable-next-line complexity
				.then(async (data) => {
					if (data === undefined) {
						if (!didSendResponse) {
							responseCallback(null, {
								data: {
									message: 'Workflow executed successfully but no data was returned',
								},
								responseCode,
							});
							didSendResponse = true;
						}
						return undefined;
					}

					if (pinData) {
						data.data.resultData.pinData = pinData;
					}

					const returnData = WorkflowHelpers.getDataLastExecutedNodeData(data);
					if (data.data.resultData.error || returnData?.error !== undefined) {
						if (!didSendResponse) {
							responseCallback(null, {
								data: {
									message: 'Error in workflow',
								},
								responseCode: 500,
							});
						}
						didSendResponse = true;
						return data;
					}

					// in `responseNode` mode `responseCallback` is called by `responsePromise`
					if (responseMode === 'responseNode' && responsePromise) {
						await Promise.allSettled([responsePromise.promise]);
						return undefined;
					}

					if (returnData === undefined) {
						if (!didSendResponse) {
							responseCallback(null, {
								data: {
									message:
										'Workflow executed successfully but the last node did not return any data',
								},
								responseCode,
							});
						}
						didSendResponse = true;
						return data;
					}

					if (!didSendResponse) {
						let data: IDataObject | IDataObject[] | undefined;

						if (responseData === 'firstEntryJson') {
							// Return the JSON data of the first entry

							if (returnData.data!.main[0]![0] === undefined) {
								responseCallback(new OperationalError('No item to return got found'), {});
								didSendResponse = true;
								return undefined;
							}

							data = returnData.data!.main[0]![0].json;

							const responsePropertyName = workflow.expression.getSimpleParameterValue(
								workflowStartNode,
								webhookData.webhookDescription.responsePropertyName,
								executionMode,
								additionalKeys,
								undefined,
								undefined,
							);

							if (responsePropertyName !== undefined) {
								data = get(data, responsePropertyName as string) as IDataObject;
							}

							const responseContentType = workflow.expression.getSimpleParameterValue(
								workflowStartNode,
								webhookData.webhookDescription.responseContentType,
								executionMode,
								additionalKeys,
								undefined,
								undefined,
							);

							if (responseContentType !== undefined) {
								// Send the webhook response manually to be able to set the content-type
								res.setHeader('Content-Type', responseContentType as string);

								// Returning an object, boolean, number, ... causes problems so make sure to stringify if needed
								if (
									data !== null &&
									data !== undefined &&
									['Buffer', 'String'].includes(data.constructor.name)
								) {
									res.end(data);
								} else {
									res.end(JSON.stringify(data));
								}

								responseCallback(null, {
									noWebhookResponse: true,
								});
								didSendResponse = true;
							}
						} else if (responseData === 'firstEntryBinary') {
							// Return the binary data of the first entry
							data = returnData.data!.main[0]![0];

							if (data === undefined) {
								responseCallback(new OperationalError('No item was found to return'), {});
								didSendResponse = true;
								return undefined;
							}

							if (data.binary === undefined) {
								responseCallback(new OperationalError('No binary data was found to return'), {});
								didSendResponse = true;
								return undefined;
							}

							const responseBinaryPropertyName = workflow.expression.getSimpleParameterValue(
								workflowStartNode,
								webhookData.webhookDescription.responseBinaryPropertyName,
								executionMode,
								additionalKeys,
								undefined,
								'data',
							);

							if (responseBinaryPropertyName === undefined && !didSendResponse) {
								responseCallback(
									new OperationalError("No 'responseBinaryPropertyName' is set"),
									{},
								);
								didSendResponse = true;
							}

							const binaryData = (data.binary as IBinaryKeyData)[
								responseBinaryPropertyName as string
							];
							if (binaryData === undefined && !didSendResponse) {
								responseCallback(
									new OperationalError(
										`The binary property '${responseBinaryPropertyName}' which should be returned does not exist`,
									),
									{},
								);
								didSendResponse = true;
							}

							if (!didSendResponse) {
								// Send the webhook response manually
								res.setHeader('Content-Type', binaryData.mimeType);
								if (binaryData.id) {
									const stream = await Container.get(BinaryDataService).getAsStream(binaryData.id);
									stream.pipe(res, { end: false });
									await finished(stream);
								} else {
									res.write(Buffer.from(binaryData.data, BINARY_ENCODING));
								}

								responseCallback(null, {
									noWebhookResponse: true,
								});
								process.nextTick(() => res.end());
							}
						} else if (responseData === 'noData') {
							// Return without data
							data = undefined;
						} else {
							// Return the JSON data of all the entries
							data = [];
							for (const entry of returnData.data!.main[0]!) {
								data.push(entry.json);
							}
						}

						if (!didSendResponse) {
							responseCallback(null, {
								data,
								responseCode,
							});
						}
					}
					didSendResponse = true;

					return data;
				})
				.catch((e) => {
					if (!didSendResponse) {
						responseCallback(
							new OperationalError('There was a problem executing the workflow', {
								cause: e,
							}),
							{},
						);
					}

					const internalServerError = new InternalServerError(e.message, e);
					if (e instanceof ExecutionCancelledError) internalServerError.level = 'warning';
					throw internalServerError;
				});
		}
		return executionId;
	} catch (e) {
		const error =
			e instanceof UnprocessableRequestError
				? e
				: new OperationalError('There was a problem executing the workflow', {
						cause: e,
					});
		if (didSendResponse) throw error;
		responseCallback(error, {});
		return;
	}
}
