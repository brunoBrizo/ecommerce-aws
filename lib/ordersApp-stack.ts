import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodeJS from "aws-cdk-lib/aws-lambda-nodejs";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamoDb from "aws-cdk-lib/aws-dynamodb";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as iam from "aws-cdk-lib/aws-iam";

interface OrdersAppStackProps extends cdk.StackProps {
  productsTable: dynamoDb.Table;
  eventsTable: dynamoDb.Table;
}

export class OrdersAppStack extends cdk.Stack {
  readonly ordersHandler: lambdaNodeJS.NodejsFunction;

  constructor(scope: Construct, id: string, props: OrdersAppStackProps) {
    super(scope, id, props);

    const ordersTable = new dynamoDb.Table(this, "OrdersTable", {
      tableName: "orders",
      partitionKey: {
        name: "pk",
        type: dynamoDb.AttributeType.STRING,
      },
      sortKey: {
        name: "sk",
        type: dynamoDb.AttributeType.STRING,
      },
      billingMode: dynamoDb.BillingMode.PROVISIONED,
      readCapacity: 1,
      writeCapacity: 1,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // This should be removed to prod
    });

    // Orders Layer
    const ordersLayerArn = ssm.StringParameter.valueForStringParameter(
      this,
      "OrdersLayerVersionArn"
    );
    const ordersLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      "OrdersLayerVersionArn",
      ordersLayerArn
    );

    // Orders Api Layer
    const ordersApiLayerArn = ssm.StringParameter.valueForStringParameter(
      this,
      "OrdersApiLayerVersionArn"
    );
    const ordersApiLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      "OrdersApiLayerVersionArn",
      ordersApiLayerArn
    );

    // Order Events Layer
    const orderEventsLayerArn = ssm.StringParameter.valueForStringParameter(
      this,
      "OrderEventsLayerVersionArn"
    );
    const orderEventsLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      "OrderEventsLayerVersionArn",
      orderEventsLayerArn
    );

    // Order Events Repository Layer
    const orderEventsRepositoryLayerArn =
      ssm.StringParameter.valueForStringParameter(
        this,
        "OrderEventsRepositoryLayerVersionArn"
      );
    const orderEventsRepositoryLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      "OrderEventsRepositoryLayerVersionArn",
      orderEventsRepositoryLayerArn
    );

    // Products Layer
    const productsLayerArn = ssm.StringParameter.valueForStringParameter(
      this,
      "ProductsLayerVersionArn"
    );
    const productsLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      "ProductsLayerVersionArn",
      productsLayerArn
    );

    // Orders Topic
    const ordersTopic = new sns.Topic(this, "OrdersTopic", {
      displayName: "Order Events Topic",
      topicName: "order-events",
    });

    this.ordersHandler = new lambdaNodeJS.NodejsFunction(
      this,
      "OrdersFunction",
      {
        runtime: lambda.Runtime.NODEJS_20_X,
        functionName: "OrdersFunction",
        entry: "lambda/orders/ordersFunction.ts",
        handler: "handler",
        memorySize: 512,
        timeout: cdk.Duration.seconds(5),
        bundling: {
          minify: true,
          sourceMap: false,
        },
        environment: {
          ORDERS_TABLE: ordersTable.tableName,
          PRODUCTS_TABLE: props.productsTable.tableName,
          ORDER_EVENTS_TOPIC_ARN: ordersTopic.topicArn,
        },
        layers: [ordersLayer, ordersApiLayer, productsLayer, orderEventsLayer],
        tracing: lambda.Tracing.ACTIVE,
        insightsVersion: lambda.LambdaInsightsVersion.VERSION_1_0_119_0,
      }
    );

    ordersTopic.grantPublish(this.ordersHandler);
    ordersTable.grantReadWriteData(this.ordersHandler);

    // Educational purpose only
    // This should not be done in a real project
    props.productsTable.grantReadData(this.ordersHandler);

    // Order Event Handler
    const orderEventsHandler = new lambdaNodeJS.NodejsFunction(
      this,
      "OrderEventsFunction",
      {
        runtime: lambda.Runtime.NODEJS_20_X,
        functionName: "OrderEventsFunction",
        entry: "lambda/orders/orderEventsFunction.ts",
        handler: "handler",
        memorySize: 512,
        timeout: cdk.Duration.seconds(5),
        bundling: {
          minify: true,
          sourceMap: false,
        },
        environment: {
          EVENTS_TABLE: props.eventsTable.tableName,
        },
        layers: [orderEventsLayer, orderEventsRepositoryLayer],
        tracing: lambda.Tracing.ACTIVE,
        insightsVersion: lambda.LambdaInsightsVersion.VERSION_1_0_119_0,
      }
    );

    // Subscribe the OrderEventsFunction to the OrdersTopic
    ordersTopic.addSubscription(
      new subs.LambdaSubscription(orderEventsHandler)
    );

    const eventsTablePolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["dynamodb:PutItem"],
      resources: [props.eventsTable.tableArn],
      conditions: {
        ["ForAllValues:StringLike"]: {
          "dynamodb:LeadingKeys": ["#order_*"],
        },
      },
    });

    orderEventsHandler.addToRolePolicy(eventsTablePolicy);
  }
}