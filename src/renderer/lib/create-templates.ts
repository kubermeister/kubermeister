/**
 * The starter manifests the Create screen's template selector inserts, apart from the screen so the
 * set can be read without a DOM. Each label is the kind the manifest declares, which is what the
 * selector shows and what a test can check the two against.
 */
export interface Template {
    id: string;
    label: string;
    api: string;
    yaml: string;
}

/**
 * Starter manifests the template selector inserts. None names a namespace: the active selection
 * supplies one when the object is written.
 */
export const TEMPLATES: Template[] = [
    {
        id: 'deployment',
        label: 'Deployment',
        api: 'apps/v1',
        yaml: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-deployment
  labels:
    app: my-app
spec:
  replicas: 2
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: app
          image: nginx:1.27
          ports:
            - containerPort: 80
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi
`,
    },
    {
        id: 'statefulset',
        label: 'StatefulSet',
        api: 'apps/v1',
        yaml: `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: my-statefulset
spec:
  serviceName: my-statefulset
  replicas: 1
  selector:
    matchLabels:
      app: my-statefulset
  template:
    metadata:
      labels:
        app: my-statefulset
    spec:
      containers:
        - name: app
          image: nginx:1.27
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: 1Gi
`,
    },
    {
        id: 'daemonset',
        label: 'DaemonSet',
        api: 'apps/v1',
        yaml: `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: my-daemonset
spec:
  selector:
    matchLabels:
      app: my-daemonset
  template:
    metadata:
      labels:
        app: my-daemonset
    spec:
      containers:
        - name: agent
          image: busybox:1.36
          command: ['sh', '-c', 'while true; do sleep 3600; done']
`,
    },
    {
        id: 'job',
        label: 'Job',
        api: 'batch/v1',
        yaml: `apiVersion: batch/v1
kind: Job
metadata:
  name: my-job
spec:
  backoffLimit: 4
  template:
    spec:
      # A Job's pods must not be restarted in place; a failure makes a new pod.
      restartPolicy: Never
      containers:
        - name: job
          image: busybox:1.36
          command: ['sh', '-c', 'echo working && sleep 5']
`,
    },
    {
        id: 'cronjob',
        label: 'CronJob',
        api: 'batch/v1',
        yaml: `apiVersion: batch/v1
kind: CronJob
metadata:
  name: my-cronjob
spec:
  # Five-field cron expression: minute hour day-of-month month day-of-week
  schedule: '0 2 * * *'
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: job
              image: busybox:1.36
              command: ['sh', '-c', 'echo hello']
`,
    },
    {
        id: 'horizontalpodautoscaler',
        label: 'HorizontalPodAutoscaler',
        api: 'autoscaling/v2',
        yaml: `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: my-autoscaler
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-deployment
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 80
`,
    },
    {
        id: 'service',
        label: 'Service',
        api: 'v1',
        yaml: `apiVersion: v1
kind: Service
metadata:
  name: my-service
spec:
  type: ClusterIP
  selector:
    app: my-app
  ports:
    - name: http
      port: 80
      targetPort: 8080
      protocol: TCP
`,
    },
    {
        id: 'ingress',
        label: 'Ingress',
        api: 'networking.k8s.io/v1',
        yaml: `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-ingress
spec:
  # ingressClassName: nginx
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: my-service
                port:
                  number: 80
`,
    },
    {
        id: 'networkpolicy',
        label: 'NetworkPolicy',
        api: 'networking.k8s.io/v1',
        yaml: `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: my-policy
spec:
  podSelector:
    matchLabels:
      app: my-app
  # Naming a type with no rule for it denies that direction outright.
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: my-client
      ports:
        - protocol: TCP
          port: 80
`,
    },
    {
        id: 'configmap',
        label: 'ConfigMap',
        api: 'v1',
        yaml: `apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
data:
  LOG_LEVEL: info
  config.yaml: |
    key: value
`,
    },
    {
        id: 'secret',
        label: 'Secret',
        api: 'v1',
        yaml: `apiVersion: v1
kind: Secret
metadata:
  name: my-secret
type: Opaque
# stringData takes plain text; the API server stores it base64-encoded.
stringData:
  password: change-me
`,
    },
    {
        id: 'persistentvolumeclaim',
        label: 'PersistentVolumeClaim',
        api: 'v1',
        yaml: `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-claim
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
  # No storageClassName: the cluster's default class provisions the volume.
`,
    },
    {
        id: 'serviceaccount',
        label: 'ServiceAccount',
        api: 'v1',
        yaml: `apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-service-account
`,
    },
    {
        id: 'role',
        label: 'Role',
        api: 'rbac.authorization.k8s.io/v1',
        yaml: `apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: my-role
rules:
  - apiGroups: ['']
    resources: ['pods']
    verbs: ['get', 'list', 'watch']
`,
    },
    {
        id: 'rolebinding',
        label: 'RoleBinding',
        api: 'rbac.authorization.k8s.io/v1',
        yaml: `apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: my-role-binding
subjects:
  # A subject with no namespace of its own is read as one in the binding's namespace.
  - kind: ServiceAccount
    name: my-service-account
roleRef:
  kind: Role
  name: my-role
  apiGroup: rbac.authorization.k8s.io
`,
    },
];
