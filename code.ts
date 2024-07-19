figma.showUI(__html__, { width: 2000, height: 1200 });

type CustomVariableAlias = {
  type: 'VARIABLE_ALIAS';
  id: string;
};

type CustomVariableValue = string | number | CustomVariableAlias | { r: number, g: number, b: number, a: number } | boolean;

type MyVariableValue = string | number | boolean | { r: number, g: number, b: number, a: number } | CustomVariableAlias | undefined;

interface CustomVariable {
  id: string;
  name: string;
  resolvedType: string;
  valuesByMode?: { [key: string]: CustomVariableValue };
}

async function handleSelectionChange() {
  const selection = figma.currentPage.selection;
  if (selection.length !== 1) {
    figma.ui.postMessage({ type: 'no-selection' });
    return;
  }

  const node = selection[0];
  const boundVariables = await getAllBoundVariablesForNode(node);
  const preview = await getPreviewImage(node);

  figma.ui.postMessage({
    type: 'selected-component',
    data: {
      name: node.name,
      preview,
      boundVariables: Object.entries(boundVariables).flatMap(([property, variables]: [string, any]) => {
        if (Array.isArray(variables)) {
          return variables.map((variable: any) => ({
            property,
            name: variable.name,
            value: variable.value
          }));
        } else {
          return {
            property,
            name: variables.name,
            value: variables.value
          };
        }
      })
    }
  });
}

figma.on('selectionchange', handleSelectionChange);
handleSelectionChange();

async function getAllBoundVariablesForNode(node: SceneNode): Promise<Record<string, any[]>> {
  let boundVariables: Record<string, any[]> = {};

  // Get bound variables for the current node
  if ('boundVariables' in node) {
    const nodeBoundVariables = await getBoundVariables(node);
    for (const [property, variables] of Object.entries(nodeBoundVariables)) {
      if (!boundVariables[property]) {
        boundVariables[property] = [];
      }
      if (Array.isArray(variables)) {
        boundVariables[property].push(...variables);
      } else {
        boundVariables[property].push(variables);
      }
    }
  }

  // Recursively get bound variables for children
  if ('children' in node) {
    for (const child of (node as unknown as FrameNode).children) {
      const childBoundVariables = await getAllBoundVariablesForNode(child);
      for (const [property, variables] of Object.entries(childBoundVariables)) {
        if (!boundVariables[property]) {
          boundVariables[property] = [];
        }
        boundVariables[property].push(...variables);
      }
    }
  }

  return boundVariables;
}

async function getBoundVariables(node: SceneNode): Promise<Record<string, any[]>> {
  const propertiesToCheck = [
    'width',
    'height',
    'fills',
    'strokes',
    'opacity',
    'cornerRadius',
    'itemSpacing',
    'paddingLeft',
    'paddingRight',
    'paddingTop',
    'paddingBottom',
    'fontFamily',
    'fontStyle',
    'fontWeight',
    'lineHeight',
    'letterSpacing',
    'paragraphSpacing',
    'paragraphIndent'
  ];

  const boundVariables: Record<string, any[]> = {};

  for (const property of propertiesToCheck) {
    if (node.boundVariables && node.boundVariables[property] !== undefined) {
      const propertyBoundVariables = node.boundVariables[property];
      if (Array.isArray(propertyBoundVariables)) {
        boundVariables[property] = await Promise.all(propertyBoundVariables.map(async (variableBinding: any) => {
          const variable = await figma.variables.getVariableByIdAsync(variableBinding.id);
          if (variable) {
            const value = await resolveVariableValue(variable, node);
            if (value === 'Unknown') {
              const fallbackValue = await resolveVariableValueFallback(variable);
              return {
                name: variable.name,
                value: fallbackValue
              };
            }
            return {
              name: variable.name,
              value
            };
          } else {
            return {
              name: 'Unknown',
              value: 'Unknown'
            };
          }
        }));
      } else {
        const variableId = propertyBoundVariables.id;
        const variable = await figma.variables.getVariableByIdAsync(variableId);
        if (variable) {
          const value = await resolveVariableValue(variable, node);
          if (value === 'Unknown') {
            const fallbackValue = await resolveVariableValueFallback(variable);
            boundVariables[property] = [{
              name: variable.name,
              value: fallbackValue
            }];
          } else {
            boundVariables[property] = [{
              name: variable.name,
              value
            }];
          }
        } else {
          boundVariables[property] = [{
            name: 'Unknown',
            value: 'Unknown'
          }];
        }
      }
    }
  }

  // Check for typography variables in TextNodes
  if (node.type === "TEXT") {
    const textNode = node as TextNode;
    const styledTextSegments = textNode.getStyledTextSegments(["boundVariables"]);
    for (const segment of styledTextSegments) {
      for (const [property, variableAlias] of Object.entries(segment.boundVariables || {})) {
        if (variableAlias.type === 'VARIABLE_ALIAS') {
          const variable = await figma.variables.getVariableByIdAsync(variableAlias.id);
          if (variable) {
            const value = await resolveVariableValue(variable, textNode);
            if (value === 'Unknown') {
              const fallbackValue = await resolveVariableValueFallback(variable);
              if (!boundVariables[property]) {
                boundVariables[property] = [];
              }
              boundVariables[property].push({
                name: variable.name,
                value: fallbackValue,
                range: [segment.start, segment.end]
              });
            } else {
              if (!boundVariables[property]) {
                boundVariables[property] = [];
              }
              boundVariables[property].push({
                name: variable.name,
                value,
                range: [segment.start, segment.end]
              });
            }
          }
        }
      }
    }
  }

  return boundVariables;
}

async function resolveVariableValue(variable: Variable, node: SceneNode): Promise<string> {
  if (variable.valuesByMode) {
    const resolvedModes = node.resolvedVariableModes || {};
    let modeId = Object.keys(variable.valuesByMode)[0]; // Default to the first mode if no resolved modes found
    for (const collectionId of Object.keys(resolvedModes)) {
      if (resolvedModes[collectionId] in variable.valuesByMode) {
        modeId = resolvedModes[collectionId];
        break;
      }
    }

    let value: MyVariableValue = variable.valuesByMode[modeId];

    while (value && (value as CustomVariableAlias).type === 'VARIABLE_ALIAS') {
      const aliasVariable = await getVariableById((value as CustomVariableAlias).id);
      if (!aliasVariable) {
        return 'Unknown';
      }
      value = aliasVariable.valuesByMode ? aliasVariable.valuesByMode[modeId] : undefined;
    }

    if (value === undefined) {
      return 'Unknown';
    }

    return formatValue(variable.resolvedType, value as CustomVariableValue);
  }
  return 'undefined';
}

async function resolveVariableValueFallback(variable: Variable): Promise<string> {
  if (variable.valuesByMode) {
    let value = Object.values(variable.valuesByMode)[0];
    while (value && (value as CustomVariableAlias).type === 'VARIABLE_ALIAS') {
      const aliasVariable = await getVariableById((value as CustomVariableAlias).id);
      if (!aliasVariable) {
        return 'Unknown';
      }
      value = Object.values(aliasVariable.valuesByMode)[0];
    }
    return formatValue(variable.resolvedType, value);
  }
  return 'undefined';
}

async function getVariableById(id: string): Promise<Variable | null> {
  const variable = await figma.variables.getVariableByIdAsync(id);
  return variable || null;
}

function formatValue(type: string, value: CustomVariableValue): string {
  if (type === 'COLOR' && typeof value === 'object' && value !== null && 'r' in value && 'g' in value && 'b' in value && 'a' in value) {
    const { r, g, b, a } = value as { r: number, g: number, b: number, a: number };
    return rgbToHex({ r, g, b, a });
  }
  if (type === 'COLOR' && typeof value === 'object' && value !== null && 'r' in value && 'g' in value && 'b' in value) {
    const { r, g, b } = value as { r: number, g: number, b: number };
    return rgbToHex({ r, g, b, a: 1 });
  }
  return value.toString();
}

function rgbToHex({ r, g, b, a }: { r: number, g: number, b: number, a: number }): string {
  const toHex = (value: number) => {
    const hex = Math.round(value * 255).toString(16);
    return hex.length === 1 ? "0" + hex : hex;
  };

  const hex = [toHex(r), toHex(g), toHex(b)];
  if (a !== 1) {
    hex.push(toHex(a));
  }
  return `#${hex.join("")}`;
}

async function getPreviewImage(node: SceneNode): Promise<string> {
  const image = await node.exportAsync({ format: 'PNG' });
  return `data:image/png;base64,${figma.base64Encode(image)}`;
}

(async () => {
  const variables = await getAllLocalVariables();
  figma.ui.postMessage({ type: 'variables', variables });
})();

async function getAllLocalVariables() {
  const localVariables: CustomVariable[] = await figma.variables.getLocalVariablesAsync() as unknown as CustomVariable[];
  const variableDetails = await Promise.all(localVariables.map(async variable => {
    const [group, name] = parseVariableName(variable.name);
    const details = {
      id: variable.id,
      group,
      name,
      type: variable.resolvedType,
      value: 'undefined',
      alias: 'No',
      usageCount: 0
    };

    if (variable.valuesByMode) {
      const value = Object.values(variable.valuesByMode)[0];
      if ((value as CustomVariableAlias).type === 'VARIABLE_ALIAS') {
        const resolvedValue = await getVariableById((value as CustomVariableAlias).id);
        details.value = resolvedValue ? formatValue(variable.resolvedType, Object.values(resolvedValue.valuesByMode)[0]) : 'Unknown';
        details.alias = 'Yes';
        details.usageCount = getUsageCount(localVariables, (value as CustomVariableAlias).id);
      } else {
        details.value = formatValue(variable.resolvedType, value);
      }
    }

    return details;
  }));

  return variableDetails;
}

function parseVariableName(variableName: string): [string, string] {
  const pathParts = variableName.split('/');
  const group = pathParts.length > 1 ? pathParts.slice(0, -1).join('/') : 'Unknown';
  const name = pathParts.length > 1 ? pathParts[pathParts.length - 1] : pathParts[0];
  return [group, name];
}

function getUsageCount(variables: CustomVariable[], id: string): number {
  return variables.reduce((count, variable) => {
    const value = variable.valuesByMode ? Object.values(variable.valuesByMode)[0] : null;
    return count + ((value as CustomVariableAlias)?.type === 'VARIABLE_ALIAS' && (value as CustomVariableAlias).id === id ? 1 : 0);
  }, 0);
}
